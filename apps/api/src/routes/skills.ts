import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type {
  InstalledSkillContent,
  InstalledSkillListResponse,
  LibrarySkillDetail,
  LibrarySkillSummary,
  SkillInstallRequest,
  SkillLibraryResponse,
  SkillRemoveRequest,
  UploadSkillRequest,
} from '@waker/contracts';
import {
  listInstalledSkills,
  readInstalledSkillContent,
  removeProjectSkill,
  SkillUploadError,
  uploadSkill,
} from '@waker/codex-runtime';
import {
  SkillContentQuerySchema,
  SkillDetailQuerySchema,
  SkillInstallSchema,
  SkillLibraryQuerySchema,
  SkillRemoveSchema,
  SkillUploadSchema,
} from '../schemas.js';
import {
  parseSkillsShDetail,
  parseSkillsShSearch,
  parseSkillsShTop,
  type SkillsShTopEntry,
} from '../lib/skills-sh.js';
import type { AppContext } from '../context.js';

const execFileAsync = promisify(execFile);

/** skills.sh 首页榜单的内存缓存：6h TTL，抓取失败时回退到上次成功的结果。 */
const TOP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let topCache: { fetchedAt: number; items: SkillsShTopEntry[] } | undefined;

/** skills.sh 详情页的内存缓存：1h TTL（详情变化慢，失败不回退——详情不是关键路径）。 */
const DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;
const detailCache = new Map<string, { fetchedAt: number; detail: LibrarySkillDetail }>();

const FETCH_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 180_000;
/** owner/repo 与 skillId 的第二道防线（schema 已按同一 pattern 校验）。 */
const SOURCE_REGEX = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
// 与 SkillNameSchema 同一 pattern：禁止纯点号与连续点。
const NAME_REGEX = /^(?!\.*$)(?!.*\.\.)[a-z0-9_.-]+$/;

class SkillsShError extends Error {}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new SkillsShError(`skills.sh 返回 ${response.status}`);
  return response.text();
}

/** 榜单模式：6h 内命中缓存直接返回；抓取失败且有旧缓存时回退旧缓存，否则抛 SkillsShError。 */
async function loadTopSkills(): Promise<SkillsShTopEntry[]> {
  if (topCache && Date.now() - topCache.fetchedAt < TOP_CACHE_TTL_MS) return topCache.items;
  try {
    const html = await fetchText('https://skills.sh/');
    const items = parseSkillsShTop(html);
    if (!items.length) throw new SkillsShError('skills.sh 首页没有解析到榜单条目');
    topCache = { fetchedAt: Date.now(), items };
    return items;
  } catch (error) {
    if (topCache) return topCache.items;
    throw error instanceof SkillsShError
      ? error
      : new SkillsShError(error instanceof Error ? error.message : 'skills.sh 暂时无法访问');
  }
}

async function searchSkills(query: string, limit: number): Promise<SkillsShTopEntry[]> {
  const body = await fetchText(
    `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  try {
    return parseSkillsShSearch(JSON.parse(body));
  } catch {
    throw new SkillsShError('skills.sh 搜索返回了无法解析的内容');
  }
}

/** 详情模式：1h 内命中缓存直接返回；抓取或解析失败抛 SkillsShError（路由映射 502）。 */
async function loadSkillDetail(source: string, skillId: string): Promise<LibrarySkillDetail> {
  const id = `${source}/${skillId}`;
  const cached = detailCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < DETAIL_CACHE_TTL_MS) return cached.detail;
  // skills.sh 会 308 到 www；直接打 www 省一跳（fetch 默认也会跟随重定向）。
  try {
    const html = await fetchText(`https://www.skills.sh/${source}/${skillId}`);
    const parsed = parseSkillsShDetail(html);
    const detail: LibrarySkillDetail = {
      id,
      name: parsed.name ?? skillId,
      source,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.installs !== undefined ? { installs: parsed.installs } : {}),
    };
    detailCache.set(id, { fetchedAt: Date.now(), detail });
    return detail;
  } catch (error) {
    throw error instanceof SkillsShError
      ? error
      : new SkillsShError(error instanceof Error ? error.message : 'skills.sh 暂时无法访问');
  }
}

/** 已安装技能名集合（.agents/skills + .codex/skills），用于给库条目打 installed 标记。 */
function installedNames(cwd: string): Set<string> {
  return new Set(listInstalledSkills(cwd).map((item) => item.name));
}

function installedResponse(cwd: string): InstalledSkillListResponse {
  const items = listInstalledSkills(cwd);
  return { items, total: items.length };
}

/** 从 execFile 异常里提取一段可读的 stderr 摘要。 */
function stderrSummary(error: unknown): string {
  const stderr = (error as { stderr?: string })?.stderr?.trim();
  const summary = (stderr || (error instanceof Error ? error.message : String(error))).replace(
    /\s+/g,
    ' ',
  );
  return summary.slice(0, 500);
}

export function registerSkillRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/skills/installed', async (): Promise<InstalledSkillListResponse> =>
    installedResponse(ctx.cwd),
  );

  app.get<{ Querystring: { scope: 'codex' | 'agents'; name: string } }>(
    '/skills/installed/content',
    {
      schema: { querystring: SkillContentQuerySchema },
    },
    async (request, reply): Promise<InstalledSkillContent | void> => {
      const { scope, name } = request.query;
      if (!NAME_REGEX.test(name)) return reply.code(400).send({ error: '技能名称不合法' });
      const content = readInstalledSkillContent(ctx.cwd, scope, name);
      if (!content) return reply.code(404).send({ error: '技能不存在' });
      return content;
    },
  );

  app.get<{ Querystring: { source: string; skillId: string } }>(
    '/skills/library/detail',
    {
      schema: { querystring: SkillDetailQuerySchema },
    },
    async (request, reply): Promise<LibrarySkillDetail | void> => {
      const { source, skillId } = request.query;
      if (!SOURCE_REGEX.test(source) || !NAME_REGEX.test(skillId))
        return reply.code(400).send({ error: '技能来源或 id 不合法' });
      try {
        return await loadSkillDetail(source, skillId);
      } catch (error) {
        if (error instanceof SkillsShError)
          return reply.code(502).send({ error: `技能详情暂时不可用：${error.message}` });
        throw error;
      }
    },
  );

  app.get<{ Querystring: { query?: string; limit?: number } }>(
    '/skills/library',
    {
      schema: { querystring: SkillLibraryQuerySchema },
    },
    async (request, reply): Promise<SkillLibraryResponse | void> => {
      const query = request.query.query?.trim() ?? '';
      const limit = request.query.limit ?? 50;
      const installed = installedNames(ctx.cwd);
      try {
        if (query.length >= 2) {
          const hits = await searchSkills(query, limit);
          const items: LibrarySkillSummary[] = hits.map((hit) => ({
            ...hit,
            installed: installed.has(hit.name),
          }));
          return { items, total: items.length, mode: 'search' };
        }
        const top = await loadTopSkills();
        const items: LibrarySkillSummary[] = top
          .slice(0, limit)
          .map((entry) => ({ ...entry, installed: installed.has(entry.name) }));
        return { items, total: items.length, mode: 'top' };
      } catch (error) {
        if (error instanceof SkillsShError)
          return reply.code(502).send({ error: `技能库暂时不可用：${error.message}` });
        throw error;
      }
    },
  );

  // 安装即 `npx -y skills add <source> --skill <skillId> -a universal -y`（写入 .agents/skills + skills-lock.json）。
  app.post<{ Body: SkillInstallRequest }>(
    '/skills/install',
    {
      schema: { body: SkillInstallSchema },
    },
    async (request, reply) => {
      const { source, skillId } = request.body;
      if (!SOURCE_REGEX.test(source) || !NAME_REGEX.test(skillId))
        return reply.code(400).send({ error: '技能来源或 id 不合法' });
      try {
        await execFileAsync(
          'npx',
          ['-y', 'skills', 'add', source, '--skill', skillId, '-a', 'universal', '-y'],
          { cwd: ctx.cwd, timeout: INSTALL_TIMEOUT_MS },
        );
      } catch (error) {
        return reply.code(502).send({ error: `技能安装失败：${stderrSummary(error)}` });
      }
      return installedResponse(ctx.cwd);
    },
  );

  app.post<{ Body: SkillRemoveRequest }>(
    '/skills/remove',
    {
      schema: { body: SkillRemoveSchema },
    },
    async (request, reply) => {
      const { name } = request.body;
      if (!NAME_REGEX.test(name)) return reply.code(400).send({ error: '技能名称不合法' });
      const installed = listInstalledSkills(ctx.cwd).find((item) => item.name === name);
      // 删除前确认确实已安装：未安装直接 404，不把未知名字透传给 skills CLI。
      if (!installed) return reply.code(404).send({ error: '技能不存在' });
      const scope = request.body.scope ?? installed.scope;
      // 手工上传/项目自带的 .codex/skills 条目直接删目录，不走 skills CLI。
      if (scope === 'codex') {
        if (!removeProjectSkill(ctx.cwd, name))
          return reply.code(404).send({ error: '技能不存在' });
        return installedResponse(ctx.cwd);
      }
      try {
        await execFileAsync('npx', ['-y', 'skills', 'remove', name, '-y'], {
          cwd: ctx.cwd,
          timeout: INSTALL_TIMEOUT_MS,
        });
      } catch (error) {
        return reply.code(502).send({ error: `技能删除失败：${stderrSummary(error)}` });
      }
      return installedResponse(ctx.cwd);
    },
  );

  // 手工上传：写入 .codex/skills/<name>/SKILL.md；409/400 与 agents 路由同一映射。
  app.post<{ Body: UploadSkillRequest }>(
    '/skills/upload',
    {
      schema: { body: SkillUploadSchema },
    },
    async (request, reply) => {
      try {
        const summary = uploadSkill(ctx.cwd, request.body);
        return reply.code(201).send(summary);
      } catch (error) {
        if (error instanceof SkillUploadError) {
          return reply.code(error.code === 'CONFLICT' ? 409 : 400).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
