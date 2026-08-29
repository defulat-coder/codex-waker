import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type {
  InstalledSkillContent,
  InstalledSkillListResponse,
  LibrarySkillDetail,
  LibrarySkillSummary,
  SkillDiffResponse,
  SkillInstallRequest,
  SkillLibraryResponse,
  SkillRemoveRequest,
  SkillRollbackRequest,
  SkillRollbackResponse,
  SkillScanReport,
  SkillSnapshotRequest,
  SkillSnapshotResponse,
  SkillVersionDetail,
  SkillVersionListResponse,
  UploadSkillRequest,
} from '@waker/contracts';
import {
  listInstalledSkills,
  applySkillRollback,
  assertSkillsMutationRootsSafe,
  createSkillSnapshot,
  diffSkillVersions,
  ensureSkillSnapshotFresh,
  getSkillVersion,
  hasRepoSkillResidue,
  listSkillVersions,
  planSkillRollback,
  readStagingMetadata,
  readInstalledSkillContent,
  removeProjectSkill,
  removeUploadedSkillSource,
  scanSkillsSafety,
  SKILLS_CLI_VERSION,
  SkillUploadError,
  SkillVersionNotFoundError,
  stageUploadedSkill,
  writeStagingMetadata,
  redactPrivateRoots,
} from '@waker/codex-runtime';
import {
  SkillContentQuerySchema,
  SkillDetailQuerySchema,
  SkillDiffQuerySchema,
  SkillInstallSchema,
  SkillLibraryQuerySchema,
  SkillRemoveSchema,
  SkillRollbackSchema,
  SkillSnapshotSchema,
  SkillUploadSchema,
  SkillVersionParamsSchema,
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
const GIT_TIMEOUT_MS = 120_000;
/** owner/repo 与 skillId 的第二道防线（schema 已按同一 pattern 校验）。 */
const SOURCE_REGEX = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
// 与 SkillNameSchema 同一 pattern：禁止纯点号与连续点。
const NAME_REGEX = /^(?!\.*$)(?!.*\.\.)[a-z0-9_.-]+$/;
const RUNTIME_NAME_REGEX = /^[a-z0-9-]{1,80}$/;

class SkillsShError extends Error {}

let mutationTail: Promise<void> = Promise.resolve();

async function serializeMutation<T>(
  cwd: string,
  skillId: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    assertSkillsMutationRootsSafe(cwd, skillId);
    return await action();
  } finally {
    release();
  }
}

function safeCommandError(error: unknown, cwd: string): string {
  const stderr = (error as { stderr?: string })?.stderr?.trim();
  return redactPrivateRoots(
    (stderr || (error instanceof Error ? error.message : String(error)))
      .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://[credentials]@')
      .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
      .replace(/\s+/g, ' ')
      .slice(0, 500),
    [cwd, homedir()],
  );
}

async function runSkillsCli(cwd: string, args: string[], skillId: string): Promise<void> {
  assertSkillsMutationRootsSafe(cwd, skillId);
  await execFileAsync('npx', ['-y', `skills@${SKILLS_CLI_VERSION}`, ...args], {
    cwd,
    timeout: INSTALL_TIMEOUT_MS,
  });
}

function assertSkillTargetAvailable(cwd: string, skillId: string): void {
  if (
    listInstalledSkills(cwd).some(
      (item) => item.name === skillId || item.path.split('/').at(-2) === skillId,
    )
  ) {
    throw new SkillUploadError('CONFLICT', `技能已存在：${skillId}`);
  }
}

async function rollbackSkillInstall(cwd: string, skillId: string): Promise<void> {
  try {
    await runSkillsCli(cwd, ['remove', skillId, '-y'], skillId);
  } catch {
    // The original install error remains primary; postcondition below detects residue.
  }
  if (hasRepoSkillResidue(cwd, skillId)) {
    throw new Error(`技能安装失败且回滚未完成：${skillId}`);
  }
}

function sourceDirectoryName(source: string): string {
  const slug = source.replace('/', '--');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 10);
  return `github-${slug}-${hash}`;
}

async function stageGithubSource(cwd: string, source: string, skillId: string): Promise<string> {
  assertSkillsMutationRootsSafe(cwd, skillId);
  const root = join(cwd, '.codex', 'skill-sources');
  mkdirSync(root, { recursive: true });
  assertSkillsMutationRootsSafe(cwd, skillId);
  const target = join(root, sourceDirectoryName(source));
  if (existsSync(target)) {
    const metadata = readStagingMetadata(cwd, target);
    if (!metadata || metadata.kind !== 'github' || metadata.source !== source || !metadata.commit)
      throw new Error('已有技能来源无法验证，拒绝复用');
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: target, timeout: 10_000 }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: target, timeout: 10_000 }),
    ]);
    if (head.trim() !== metadata.commit || status.trim())
      throw new Error('技能来源 checkout 已漂移，拒绝以原始来源名安装');
  } else {
    const temporary = mkdtempSync(join(root, '.tmp-github-'));
    try {
      await execFileAsync(
        'git',
        [
          'clone',
          '--depth',
          '1',
          '--filter=blob:none',
          `https://github.com/${source}.git`,
          temporary,
        ],
        { cwd, timeout: GIT_TIMEOUT_MS },
      );
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: temporary,
        timeout: 10_000,
      });
      writeStagingMetadata(temporary, {
        kind: 'github',
        source,
        skillId,
        commit: stdout.trim(),
      });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  return target;
}

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
      thirdParty: true,
      contentReviewed: false,
      riskNotice: 'skills.sh 是第三方发现源；安装前尚未审查仓库中的 SKILL.md、脚本或工具依赖。',
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

function isLibrarySkillInstalled(
  entry: Pick<LibrarySkillSummary, 'id' | 'source'>,
  installed: ReturnType<typeof listInstalledSkills>,
): boolean {
  const skillId = entry.id.split('/').at(-1);
  return installed.some(
    (item) =>
      item.availability === 'available' &&
      item.source === entry.source &&
      (item.name === skillId || item.path.split('/').at(-2) === skillId),
  );
}

function installedResponse(cwd: string): InstalledSkillListResponse {
  const items = listInstalledSkills(cwd);
  return { items, total: items.length };
}

export function registerSkillRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 惰性自动版本：读请求时发现 .agents/skills 指纹与最新快照不一致就记一版（只读归档）。
  const autoSnapshot = (): void => {
    try {
      ensureSkillSnapshotFresh(ctx.cwd);
    } catch (error) {
      app.log.warn(error, 'skill 自动快照失败');
    }
  };

  app.get('/skills/installed', async (): Promise<InstalledSkillListResponse> => {
    autoSnapshot();
    return installedResponse(ctx.cwd);
  });

  // 内容版本（快照式，对齐旧版 versions/diff/rollback 语义；Skills CLI 仍管安装/卸载）。
  app.get('/skills/versions', async (): Promise<SkillVersionListResponse> => {
    autoSnapshot();
    const items = listSkillVersions(ctx.cwd).map(({ files: _files, ...summary }) => summary);
    return { items, total: items.length };
  });

  // 手动全量安全扫描：本地 skill 入站面是文件系统变化（CLI 安装/手动放入），
  // 自动扫描挂在记版时（added/modified），此端点扫当前目录全量；只报告不拦截。
  app.post('/skills/scan', async (): Promise<SkillScanReport> => scanSkillsSafety(ctx.cwd));

  app.post<{ Body: SkillSnapshotRequest }>(
    '/skills/snapshots',
    { schema: { body: SkillSnapshotSchema } },
    async (request): Promise<SkillSnapshotResponse> =>
      createSkillSnapshot(ctx.cwd, {
        trigger: 'manual',
        ...(request.body?.label ? { label: request.body.label } : {}),
      }),
  );

  app.get<{ Params: { versionId: string } }>(
    '/skills/versions/:versionId',
    { schema: { params: SkillVersionParamsSchema } },
    async (request, reply): Promise<SkillVersionDetail | void> => {
      const version = getSkillVersion(ctx.cwd, request.params.versionId);
      if (!version) return reply.code(404).send({ error: `技能版本不存在：${request.params.versionId}` });
      return version;
    },
  );

  app.get<{ Querystring: { from: string; to: string } }>(
    '/skills/diff',
    { schema: { querystring: SkillDiffQuerySchema } },
    async (request, reply): Promise<SkillDiffResponse | void> => {
      try {
        return diffSkillVersions(ctx.cwd, request.query.from, request.query.to);
      } catch (error) {
        if (error instanceof SkillVersionNotFoundError)
          return reply.code(404).send({ error: error.message });
        throw error;
      }
    },
  );

  // rollback 默认 dry-run 只回变更计划；apply=true 才写 .agents/skills，
  // 写入前自动把当前状态打成一版（trigger='rollback'），回滚本身可反悔。
  app.post<{ Body: SkillRollbackRequest }>(
    '/skills/rollback',
    { schema: { body: SkillRollbackSchema } },
    async (request, reply): Promise<SkillRollbackResponse | void> => {
      const { versionId, apply, reason } = request.body;
      try {
        if (!apply) {
          const { plan } = planSkillRollback(ctx.cwd, versionId);
          return { versionId, applied: false, plan };
        }
        const result = applySkillRollback(ctx.cwd, versionId, reason);
        return {
          versionId,
          applied: true,
          plan: result.plan,
          ...(result.preSnapshotId ? { preSnapshotId: result.preSnapshotId } : {}),
        };
      } catch (error) {
        if (error instanceof SkillVersionNotFoundError)
          return reply.code(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get<{
    Querystring: { scope: 'codex' | 'agents'; name: string; locator?: string };
  }>(
    '/skills/installed/content',
    {
      schema: { querystring: SkillContentQuerySchema },
    },
    async (request, reply): Promise<InstalledSkillContent | void> => {
      const { scope, name, locator } = request.query;
      if (!NAME_REGEX.test(name)) return reply.code(400).send({ error: '技能名称不合法' });
      const content = readInstalledSkillContent(ctx.cwd, scope, name, locator);
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
      if (!SOURCE_REGEX.test(source) || !RUNTIME_NAME_REGEX.test(skillId))
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
      const installed = listInstalledSkills(ctx.cwd);
      try {
        if (query.length >= 2) {
          const hits = await searchSkills(query, limit);
          const items: LibrarySkillSummary[] = hits.map((hit) => ({
            ...hit,
            installed: isLibrarySkillInstalled(hit, installed),
          }));
          return { items, total: items.length, mode: 'search' };
        }
        const top = await loadTopSkills();
        const items: LibrarySkillSummary[] = top
          .slice(0, limit)
          .map((entry) => ({ ...entry, installed: isLibrarySkillInstalled(entry, installed) }));
        return { items, total: items.length, mode: 'top' };
      } catch (error) {
        if (error instanceof SkillsShError)
          return reply.code(502).send({ error: `技能库暂时不可用：${error.message}` });
        throw error;
      }
    },
  );

  // GitHub is cloned into a durable host source first; only the pinned Skills CLI mutates
  // .agents/skills and skills-lock.json.
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
        await serializeMutation(ctx.cwd, skillId, async () => {
          assertSkillTargetAvailable(ctx.cwd, skillId);
          const staged = await stageGithubSource(ctx.cwd, source, skillId);
          try {
            await runSkillsCli(
              ctx.cwd,
              ['add', staged, '--skill', skillId, '--copy', '-a', 'universal', '-y'],
              skillId,
            );
            const installed = listInstalledSkills(ctx.cwd).find(
              (item) =>
                item.scope === 'agents' &&
                item.availability === 'available' &&
                item.valid &&
                item.source === source &&
                (item.name === skillId || item.path.split('/').at(-2) === skillId),
            );
            if (!installed) throw new Error('Skills CLI 完成后未找到匹配的有效技能');
          } catch (error) {
            await rollbackSkillInstall(ctx.cwd, skillId);
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof SkillUploadError && error.code === 'CONFLICT')
          return reply.code(409).send({ error: error.message });
        return reply.code(502).send({ error: `技能安装失败：${safeCommandError(error, ctx.cwd)}` });
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
      const { name, locator } = request.body;
      if (!NAME_REGEX.test(name)) return reply.code(400).send({ error: '技能名称不合法' });
      const installed = listInstalledSkills(ctx.cwd).find((item) => item.locator === locator);
      // 删除前确认确实已安装：未安装直接 404，不把未知名字透传给 skills CLI。
      if (!installed) return reply.code(404).send({ error: '技能不存在' });
      const scope = request.body.scope ?? installed.scope;
      if (scope !== installed.scope) return reply.code(404).send({ error: '技能不存在' });
      // Project CODEX_HOME sources are the only direct filesystem deletion path.
      if (scope === 'codex') {
        const removed = await serializeMutation(ctx.cwd, undefined, async () =>
          removeProjectSkill(ctx.cwd, name, installed.locator),
        );
        if (!removed) return reply.code(404).send({ error: '技能不存在' });
        return installedResponse(ctx.cwd);
      }
      try {
        await serializeMutation(ctx.cwd, installed.path.split('/').at(-2), async () => {
          const directoryName = installed.path.split('/').at(-2);
          if (!directoryName) throw new Error('技能目录无法识别');
          await runSkillsCli(ctx.cwd, ['remove', directoryName, '-y'], directoryName);
          if (hasRepoSkillResidue(ctx.cwd, directoryName))
            throw new Error('Skills CLI 完成后技能仍然存在');
          if (
            installed.source === 'local-upload' &&
            !removeUploadedSkillSource(ctx.cwd, installed.lock?.source, directoryName)
          ) {
            throw new Error('技能已移除，但上传来源清理失败');
          }
        });
      } catch (error) {
        return reply.code(502).send({ error: `技能删除失败：${safeCommandError(error, ctx.cwd)}` });
      }
      return installedResponse(ctx.cwd);
    },
  );

  // Instruction-only uploads are staged under .codex/skill-sources, then installed
  // into the real repo skill location through the same pinned Skills CLI.
  app.post<{ Body: UploadSkillRequest }>(
    '/skills/upload',
    {
      schema: { body: SkillUploadSchema },
    },
    async (request, reply) => {
      try {
        const summary = await serializeMutation(ctx.cwd, request.body.name.trim(), async () => {
          const staged = stageUploadedSkill(ctx.cwd, request.body);
          assertSkillTargetAvailable(ctx.cwd, staged.name);
          try {
            await runSkillsCli(
              ctx.cwd,
              ['add', staged.directory, '--skill', staged.name, '--copy', '-a', 'universal', '-y'],
              staged.name,
            );
            const installed = listInstalledSkills(ctx.cwd).find(
              (item) =>
                item.scope === 'agents' &&
                item.path === `.agents/skills/${staged.name}/SKILL.md` &&
                item.valid,
            );
            if (!installed) throw new Error('Skills CLI 完成后未找到上传的有效技能');
            return installed;
          } catch (error) {
            await rollbackSkillInstall(ctx.cwd, staged.name);
            throw error;
          }
        });
        return reply.code(201).send(summary);
      } catch (error) {
        if (error instanceof SkillUploadError) {
          return reply.code(error.code === 'CONFLICT' ? 409 : 400).send({ error: error.message });
        }
        return reply.code(502).send({ error: `技能上传失败：${safeCommandError(error, ctx.cwd)}` });
      }
    },
  );
}
