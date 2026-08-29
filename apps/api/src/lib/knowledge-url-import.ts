/**
 * 网页链接导入知识库的本地实现：服务端直接抓取 URL，把 HTML 粗提取为 Markdown。
 * 无第三方依赖；协议白名单 + 私网/loopback 拒绝做基础 SSRF 防护（本地工具，不做 DNS 解析）。
 */
import { decodeHtmlEntities } from './skills-sh.js';

export const MAX_KNOWLEDGE_IMPORT_URLS = 20;
export const KNOWLEDGE_URL_FETCH_TIMEOUT_MS = 15_000;
export const KNOWLEDGE_URL_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** 抓取/校验失败的单条原因，消息直接透传给前端逐条反馈。 */
export class ImportUrlError extends Error {}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
    return true;
  if (host.includes(':')) {
    // IPv6：loopback、未指定地址与 ULA（fc00::/7）。
    return host === '::1' || /^0(?::0)*:(?::0)*:1$/.test(host) || /^f[cd]/.test(host);
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** 协议白名单 + 私网拒绝；返回规范化后的 URL 字符串。 */
export function checkImportUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: '不是合法的链接' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: '仅支持 http/https 链接' };
  if (isPrivateHost(url.hostname)) return { ok: false, reason: '不允许导入内网地址' };
  return { ok: true, url: url.toString() };
}

function fallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return (last ? decodeURIComponent(last) : parsed.hostname).slice(0, 240);
  } catch {
    return url.slice(0, 240);
  }
}

/** 把 HTML 粗提取为 Markdown：title + 正文文本，标题/列表转 Markdown，其余标签剥掉。 */
export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const title = (
    decodeHtmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim() || fallbackTitle(url)
  ).slice(0, 240);
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const container =
    /<article\b[\s\S]*?<\/article>/i.exec(stripped)?.[0] ??
    /<main\b[\s\S]*?<\/main>/i.exec(stripped)?.[0] ??
    /<body\b[\s\S]*?<\/body>/i.exec(stripped)?.[0] ??
    stripped;
  const text = decodeHtmlEntities(
    container
      .replace(/<(nav|header|footer|aside|form|iframe|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
      .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
      .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|pre|figure)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  );
  const markdown = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!markdown) return { title, markdown: '' };
  // 首行 h1 与页面 title 相同时避免标题重复。
  const firstLine = markdown.split('\n', 1)[0]!;
  const body = firstLine === `# ${title}` ? markdown.slice(firstLine.length).trim() : markdown;
  return { title, markdown: `# ${title}${body ? `\n\n${body}` : ''}` };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ImportUrlError('页面超过 5 MB，未导入');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export type FetchedPage = { title: string; markdown: string; finalUrl: string };

/** 抓取单个 URL 并转成 Markdown；手动跟随重定向并逐跳重新校验（SSRF）。 */
export async function fetchUrlMarkdown(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedPage> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = checkImportUrl(current);
    if (!check.ok) throw new ImportUrlError(check.reason);
    let response: Response;
    try {
      response = await fetchImpl(check.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(KNOWLEDGE_URL_FETCH_TIMEOUT_MS),
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.1',
          'user-agent': 'WakerKnowledgeImport/1.0',
        },
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new ImportUrlError('抓取超时（15 秒）');
      throw new ImportUrlError('无法连接到目标站点');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ImportUrlError(`重定向缺少目标（HTTP ${response.status}）`);
      current = new URL(location, check.url).toString();
      continue;
    }
    if (!response.ok) throw new ImportUrlError(`抓取失败（HTTP ${response.status}）`);
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const isHtml =
      contentType === '' || contentType === 'text/html' || contentType === 'application/xhtml+xml';
    const isText =
      contentType === 'text/plain' ||
      contentType === 'text/markdown' ||
      contentType === 'text/x-markdown';
    if (!isHtml && !isText) throw new ImportUrlError(`不支持的内容类型 ${contentType}`);
    const body = await readCapped(response, KNOWLEDGE_URL_MAX_BYTES);
    if (!body.trim()) throw new ImportUrlError('页面没有可导入的内容');
    if (isText) return { title: fallbackTitle(check.url), markdown: body, finalUrl: check.url };
    const { title, markdown } = htmlToMarkdown(body, check.url);
    if (!markdown) throw new ImportUrlError('页面没有可提取的正文');
    return { title, markdown, finalUrl: check.url };
  }
  throw new ImportUrlError('重定向次数过多');
}
