/**
 * skills.sh 数据通道的纯解析函数（无网络、无状态，便于单测）。
 * - 榜单：首页 SSR HTML 里的 <a href="/owner/repo/skillId"> 行（排名、h3 名称、
 *   owner/repo、紧凑安装量、"Weekly installs: …" sparkline aria-label）。
 * - 搜索：/api/search JSON（无描述、无安装量字段）。
 */

/** skills.sh 详情页三段式 id 的每一段。 */
const SEGMENT = '[a-zA-Z0-9_.-]+';
const ANCHOR_PATTERN = new RegExp(
  `<a\\s+[^>]*href="/(${SEGMENT}/${SEGMENT}/${SEGMENT})"[^>]*>.*?</a\\s*>`,
  'gs',
);

export interface SkillsShTopEntry {
  id: string;
  name: string;
  source: string;
  installs: number;
  weeklyInstalls?: number[];
  rank?: number;
}

/** "3.1M" → 3100000，"653K" → 653000，"1,234" → 1234；无法解析返回 undefined。 */
export function parseCompactCount(text: string): number | undefined {
  const match = /^([\d.,]+)\s*([KMB])?$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(value)) return undefined;
  const scale = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]?.toUpperCase() ?? ''] ?? 1;
  return Math.round(value * scale);
}

/** "113,781, 109,199" → [113781, 109199]（数字间是 ", "，千分位是 ","）；空输入返回 undefined。 */
function parseWeeklyInstalls(label: string | undefined): number[] | undefined {
  if (!label) return undefined;
  const values = label
    .split(/,\s+/)
    .map((part) => Number(part.replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
  return values.length ? values : undefined;
}

/**
 * 解析 skills.sh 首页榜单 HTML。只收「完整行」（排名 + 名称 + owner/repo + 安装量），
 * 页面上其它三段式链接（footer 等）会被跳过；按 id 去重，保持页面顺序。
 */
export function parseSkillsShTop(html: string): SkillsShTopEntry[] {
  const seen = new Set<string>();
  const entries: SkillsShTopEntry[] = [];
  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const block = match[0];
    const id = match[1]!;
    if (seen.has(id)) continue;
    const rank = /<span[^>]*class="[^"]*font-mono[^"]*"[^>]*>(\d+)<\/span>/.exec(block);
    const name = /<h3[^>]*>([^<]+)<\/h3>/.exec(block);
    const source = new RegExp(`<p[^>]*>\\s*(${SEGMENT}/${SEGMENT})\\s*</p>`).exec(block);
    const installs =
      /<span class="font-mono text-sm text-foreground">([\d.,]+[KMB]?)<\/span>/i.exec(block);
    if (!rank || !name || !source || !installs) continue;
    const count = parseCompactCount(installs[1]!);
    if (count === undefined) continue;
    seen.add(id);
    const weekly = /aria-label="Weekly installs: ([\d, ]+)"/.exec(block);
    const weeklyInstalls = parseWeeklyInstalls(weekly?.[1]);
    entries.push({
      id,
      name: name[1]!.trim(),
      source: source[1]!,
      installs: count,
      rank: Number(rank[1]),
      ...(weeklyInstalls ? { weeklyInstalls } : {}),
    });
  }
  return entries;
}

/** /api/search 的单条返回（无描述、无安装量）。 */
interface SkillsShSearchHit {
  id?: unknown;
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
  source?: unknown;
}

/**
 * 解析 /api/search 的 JSON body。坏形状（非数组、缺字段）的条目直接跳过；
 * installs 缺失按 0（契约字段，UI 格式化时 0 显示为 "0"）。
 */
export function parseSkillsShSearch(body: unknown): SkillsShTopEntry[] {
  const skills = (body as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return [];
  const entries: SkillsShTopEntry[] = [];
  for (const hit of skills as SkillsShSearchHit[]) {
    if (
      typeof hit?.id !== 'string' ||
      typeof hit.skillId !== 'string' ||
      typeof hit.source !== 'string'
    )
      continue;
    const name = typeof hit.name === 'string' && hit.name.trim() ? hit.name.trim() : hit.skillId;
    const installs =
      typeof hit.installs === 'number' && Number.isFinite(hit.installs) ? hit.installs : 0;
    entries.push({ id: hit.id, name, source: hit.source, installs });
  }
  return entries;
}

/** 命名/十进制/十六进制 HTML 实体解码（og:* content 里的常见转义）。 */
export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[entity] ?? whole;
  });
}

/** skills.sh 详情页解析结果（name/description/installs 均可缺省）。 */
export interface SkillsShDetailEntry {
  name?: string;
  description?: string;
  installs?: number;
}

/**
 * 解析 skills.sh 详情页 SSR HTML：描述取 og:description（实体已解码），
 * 名称取 h1（退回 og:title 的「name — owner/repo」前缀），安装量取侧栏
 * 「Installs」标签后的大数字。字段缺失时不报错，留给路由决定够不够。
 */
export function parseSkillsShDetail(html: string): SkillsShDetailEntry {
  const ogDescription = /<meta property="og:description" content="([^"]*)"\s*\/?>/.exec(html);
  const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(html);
  const ogTitle = /<meta property="og:title" content="([^"]*)"\s*\/?>/.exec(html);
  const installsBlock = /Installs<\/span><\/div><div[^>]*>([\d.,]+[KMB]?)<\/div>/.exec(html);
  const name = (h1?.[1] ?? ogTitle?.[1]?.split('—')[0])?.trim();
  const description = ogDescription?.[1]?.trim();
  const installs = installsBlock ? parseCompactCount(installsBlock[1]!) : undefined;
  return {
    ...(name ? { name: decodeHtmlEntities(name) } : {}),
    ...(description ? { description: decodeHtmlEntities(description) } : {}),
    ...(installs !== undefined ? { installs } : {}),
  };
}
