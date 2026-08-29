import {
  AGENT_ID_PATTERN,
  AGENT_THINKING_LEVELS,
  type AgentPackageImportReport,
} from '@waker/contracts';
import {
  AGENT_BODY_MAX_BYTES,
  AgentCreateError,
  deleteAgent,
  deletePreference,
  getPreferences,
  importAgent,
  listCodexModels,
  loadAgents,
  parseFrontmatter,
  readAgentAvatar,
  readAgentSource,
  setPreference,
  writeAgentAvatar,
} from '@waker/codex-runtime';
import type { MemoryDocument } from '@waker/memory';
import type {
  Automation,
  AutomationThinkingLevel,
  Connector,
  MisfirePolicy,
  Project,
  Workflow,
  WorkflowStatus,
} from '@waker/workspace-data';
import type { AppContext } from '../context.js';
import { unzipEntries, zipEntries, ZipError } from './zip.js';

/**
 * Agent 整包（对齐 QoderWake 0.4.2 export-package/import-package 的语义）：
 * 一个 ZIP 携带 manifest.json + agent.md + 可选 avatar + data/<domain>.json。
 * 本地语义与旧版的差异：channels 是全局数据不按 Waker 导出；session 绑定
 * （Codex thread）不可移植，不导出；knowledge 只导出 notebook 绑定元数据，
 * 不导出文档全文，避免包体积失控。
 */

export const AGENT_PACKAGE_FORMAT = 'waker-agent-package';
export const AGENT_PACKAGE_VERSION = 1;
export const AGENT_PACKAGE_MAX_BYTES = 20 * 1024 * 1024;

const UNZIP_LIMITS = {
  maxEntries: 256,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

/** 允许保留的 Agent frontmatter 字段；其余（含任何工具声明）导入时剥离并上报。 */
const ALLOWED_FRONTMATTER_KEYS = new Set([
  'name',
  'mark',
  'tagline',
  'description',
  'avatar',
  'suggestions',
  'strengths',
  'workStyles',
]);

const AGENT_ID_REGEX = new RegExp(AGENT_ID_PATTERN);

/** Import failures that map onto a specific HTTP status (400 坏包 / 409 冲突)。 */
export class PackageImportError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PackageImportError';
  }
}

interface PackageIncludes {
  avatar: boolean;
  memories: boolean;
  projects: boolean;
  automations: boolean;
  workflows: boolean;
  connectors: boolean;
  preferences: boolean;
  knowledgeBindings: boolean;
}

interface PackageManifest {
  format: string;
  version: number;
  agentId: string;
  name: string;
  exportedAt: string;
  includes: PackageIncludes;
  files: Array<{ path: string; type: string }>;
}

interface ExportedPreferences {
  thinking?: unknown;
  model?: unknown;
}

interface ExportedKnowledgeBinding {
  notebookId: string;
  notebookName: string;
  canWrite: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// --- 导出 -------------------------------------------------------------------------

/** 导出内容对齐 delete-impact 的归属口径：只包含该 Waker 自己拥有的记录。 */
export function buildAgentPackage(
  ctx: AppContext,
  agentId: string,
): { data: Buffer; fileName: string } {
  const agent = loadAgents(ctx.cwd).find((item) => item.id === agentId);
  if (!agent) throw new PackageImportError(404, `Agent 不存在：${agentId}`);

  const entries: Array<{ path: string; data: Buffer }> = [];
  const files: PackageManifest['files'] = [];
  const addJson = (path: string, type: string, value: unknown) => {
    entries.push({ path, data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8') });
    files.push({ path, type });
  };

  entries.push({ path: 'agent.md', data: Buffer.from(readAgentSource(ctx.cwd, agentId), 'utf8') });
  files.push({ path: 'agent.md', type: 'agent-definition' });

  const avatar = readAgentAvatar(ctx.cwd, agentId);
  if (avatar) {
    const path = avatar.mimeType === 'image/png' ? 'avatar.png' : 'avatar.jpg';
    entries.push({ path, data: avatar.data });
    files.push({ path, type: 'agent-avatar' });
  }

  const scope = { type: 'waker' as const, id: agentId };
  // MemoryStore.exportJson 是正式导出 API；payload 含 formatVersion/documents。
  const memories = JSON.parse(ctx.memory.exportJson({ scope })) as {
    documents: MemoryDocument[];
  };
  if (memories.documents.length) addJson('data/memories.json', 'memories', memories);

  const projects = ctx.workspaceData
    .listProjects(agentId)
    .filter((project) => project.wakerId === agentId);
  if (projects.length) addJson('data/projects.json', 'projects', projects);

  // triggerKey 是入站触发的鉴权密钥，不进包；导入时由 store 重新生成。
  const automations = ctx.workspaceData
    .listAutomations(agentId)
    .map(({ triggerKey: _triggerKey, ...rest }) => rest);
  if (automations.length) addJson('data/automations.json', 'automations', automations);

  const workflows = ctx.workspaceData.listWorkflows(agentId);
  if (workflows.length) addJson('data/workflows.json', 'workflows', workflows);

  const connectors = ctx.workspaceData.listConnectors(agentId);
  if (connectors.length) addJson('data/connectors.json', 'connectors', connectors);

  const allPreferences = getPreferences(ctx.cwd);
  const preferences: ExportedPreferences = {};
  if (`thinking.${agentId}` in allPreferences)
    preferences.thinking = allPreferences[`thinking.${agentId}`];
  if (`model.${agentId}` in allPreferences) preferences.model = allPreferences[`model.${agentId}`];
  if (preferences.thinking !== undefined || preferences.model !== undefined) {
    addJson('data/preferences.json', 'preferences', preferences);
  }

  // 绑定元数据即可（notebookId + 名称 + 可写位），文档全文不随包走。
  const notebookNames = new Map(
    ctx.knowledge.listNotebooks().map((notebook) => [notebook.id, notebook.name]),
  );
  const knowledgeBindings: ExportedKnowledgeBinding[] = ctx.knowledge
    .listBindings()
    .filter((binding) => binding.scopeType === 'waker' && binding.scopeId === agentId)
    .map((binding) => ({
      notebookId: binding.notebookId,
      notebookName: notebookNames.get(binding.notebookId) ?? '',
      canWrite: binding.canWrite,
    }));
  if (knowledgeBindings.length) {
    addJson('data/knowledge-bindings.json', 'knowledge-bindings', knowledgeBindings);
  }

  const includes: PackageIncludes = {
    avatar: Boolean(avatar),
    memories: memories.documents.length > 0,
    projects: projects.length > 0,
    automations: automations.length > 0,
    workflows: workflows.length > 0,
    connectors: connectors.length > 0,
    preferences: preferences.thinking !== undefined || preferences.model !== undefined,
    knowledgeBindings: knowledgeBindings.length > 0,
  };
  const manifest: PackageManifest = {
    format: AGENT_PACKAGE_FORMAT,
    version: AGENT_PACKAGE_VERSION,
    agentId,
    name: agent.name,
    exportedAt: new Date().toISOString(),
    includes,
    files,
  };
  entries.push({
    path: 'manifest.json',
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  });
  return { data: zipEntries(entries), fileName: `${agentId}.wakerpack` };
}

// --- 导入 -------------------------------------------------------------------------

/** ZIP 内路径必须是普通相对路径：拒绝绝对路径、盘符、反斜杠与 `..` 穿越段。 */
function assertSafePackagePath(path: string): void {
  if (
    !path ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => segment === '..')
  ) {
    throw new PackageImportError(400, `ZIP 包含非法路径条目：${path || '(空路径)'}`);
  }
}

interface ParsedPackage {
  manifest: PackageManifest;
  agentMarkdown: string;
  agentName: string;
  strippedFrontmatter: string[];
  avatar?: { data: Buffer; mimeType: string };
  /** avatar.png|jpg 条目存在但 magic bytes 不合法。 */
  invalidAvatar: boolean;
  memories: MemoryDocument[];
  projects: Project[];
  automations: Array<Omit<Automation, 'triggerKey'>>;
  workflows: Workflow[];
  connectors: Connector[];
  preferences: ExportedPreferences;
  knowledgeBindings: ExportedKnowledgeBinding[];
}

function parseJsonEntry(
  entries: Map<string, Buffer>,
  path: string,
  validate: (value: unknown) => boolean,
  description: string,
): unknown {
  const raw = entries.get(path);
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PackageImportError(400, `包内 ${path} 不是合法 JSON`);
  }
  if (!validate(value)) {
    throw new PackageImportError(400, `包内 ${path} 结构不合法（应为${description}）`);
  }
  return value;
}

function avatarFor(path: string, data: Buffer): ParsedPackage['avatar'] {
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (path === 'avatar.png' && pngMagic.every((byte, index) => data[index] === byte)) {
    return { data, mimeType: 'image/png' };
  }
  if (path === 'avatar.jpg' && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { data, mimeType: 'image/jpeg' };
  }
  return undefined;
}

function parsePackage(zipData: Buffer): ParsedPackage {
  let unzipped;
  try {
    unzipped = unzipEntries(zipData, UNZIP_LIMITS);
  } catch (error) {
    if (error instanceof ZipError) throw new PackageImportError(400, error.message);
    throw error;
  }
  const entries = new Map<string, Buffer>();
  for (const entry of unzipped) {
    assertSafePackagePath(entry.path);
    entries.set(entry.path, entry.data);
  }

  const manifestValue = parseJsonEntry(
    entries,
    'manifest.json',
    isRecord,
    'manifest JSON 对象',
  ) as Record<string, unknown> | undefined;
  if (!manifestValue) throw new PackageImportError(400, '包缺少 manifest.json');
  if (manifestValue.format !== AGENT_PACKAGE_FORMAT) {
    throw new PackageImportError(400, '不是 Agent 整包（manifest.format 不匹配）');
  }
  if (manifestValue.version !== AGENT_PACKAGE_VERSION) {
    throw new PackageImportError(400, `不支持的整包版本：${String(manifestValue.version)}`);
  }
  const manifest = manifestValue as unknown as PackageManifest;
  if (typeof manifest.agentId !== 'string' || !AGENT_ID_REGEX.test(manifest.agentId)) {
    throw new PackageImportError(400, 'manifest.agentId 不是合法 Agent id');
  }

  const agentEntry = entries.get('agent.md');
  if (!agentEntry) throw new PackageImportError(400, '包缺少 agent.md');
  const agentMarkdown = agentEntry.toString('utf8');
  const { frontmatter, body } = parseFrontmatter(agentMarkdown);
  const strippedFrontmatter = Object.keys(frontmatter)
    .filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key))
    .sort();
  // dry-run 也要诚实：与 importAgent 同一组必填校验，坏定义直接 400 而不是等到 apply。
  for (const field of ['name', 'mark', 'tagline', 'description'] as const) {
    const value = frontmatter[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new PackageImportError(400, `agent.md 缺少合法的 frontmatter 字段：${field}`);
    }
  }
  if (
    !Array.isArray(frontmatter.suggestions) ||
    !frontmatter.suggestions.length ||
    frontmatter.suggestions.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new PackageImportError(400, 'agent.md 的 suggestions 必须是非空字符串数组');
  }
  if (!body.trim()) throw new PackageImportError(400, 'agent.md 缺少系统提示词正文');
  if (Buffer.byteLength(body.trim(), 'utf8') > AGENT_BODY_MAX_BYTES) {
    throw new PackageImportError(400, 'agent.md 正文超过 32KB 上限');
  }

  const avatarEntry = ['avatar.png', 'avatar.jpg'].find((path) => entries.has(path));
  const avatar = avatarEntry ? avatarFor(avatarEntry, entries.get(avatarEntry)!) : undefined;

  const memoriesValue = parseJsonEntry(
    entries,
    'data/memories.json',
    (value) =>
      isRecord(value) && value.formatVersion === 1 && Array.isArray(value.documents),
    '{formatVersion: 1, documents: []}',
  ) as { documents: MemoryDocument[] } | undefined;

  const arrayEntry = <T>(path: string, itemDescription: string): T[] => {
    const value = parseJsonEntry(entries, path, Array.isArray, `${itemDescription}数组`);
    return (value as T[] | undefined) ?? [];
  };

  return {
    manifest,
    agentMarkdown,
    agentName: (frontmatter.name as string).trim(),
    strippedFrontmatter,
    ...(avatar ? { avatar } : {}),
    invalidAvatar: Boolean(avatarEntry) && !avatar,
    memories: memoriesValue?.documents ?? [],
    projects: arrayEntry<Project>('data/projects.json', 'projects'),
    automations: arrayEntry<Omit<Automation, 'triggerKey'>>('data/automations.json', 'automations'),
    workflows: arrayEntry<Workflow>('data/workflows.json', 'workflows'),
    connectors: arrayEntry<Connector>('data/connectors.json', 'connectors'),
    preferences:
      (parseJsonEntry(entries, 'data/preferences.json', isRecord, 'preferences 对象') as
        | ExportedPreferences
        | undefined) ?? {},
    knowledgeBindings: arrayEntry<ExportedKnowledgeBinding>(
      'data/knowledge-bindings.json',
      'knowledge-bindings',
    ),
  };
}

/** Overwrite 模式：清掉目标 Waker 在包内包含的同类数据，再按包内容重建。 */
function clearIncludedData(
  ctx: AppContext,
  targetId: string,
  includes: Partial<PackageIncludes>,
): void {
  if (includes.automations) ctx.workspaceData.deleteAutomationsForWaker(targetId);
  if (includes.workflows) ctx.workspaceData.deleteWorkflowsForWaker(targetId);
  if (includes.connectors) {
    for (const connector of ctx.workspaceData.listConnectors(targetId)) {
      ctx.workspaceData.deleteConnector(targetId, connector.id);
    }
  }
  if (includes.projects) {
    for (const project of ctx.workspaceData
      .listProjects(targetId)
      .filter((item) => item.wakerId === targetId)) {
      ctx.workspaceData.deleteProject(targetId, project.id);
    }
  }
  if (includes.memories) {
    const scope = { type: 'waker' as const, id: targetId };
    for (const document of ctx.memory.list({ scope })) {
      ctx.memory.delete(document.id, { expectedVersion: document.version, scope });
    }
  }
  if (includes.preferences) {
    deletePreference(ctx.cwd, `thinking.${targetId}`);
    deletePreference(ctx.cwd, `model.${targetId}`);
  }
  if (includes.knowledgeBindings) {
    for (const binding of ctx.knowledge
      .listBindings()
      .filter((item) => item.scopeType === 'waker' && item.scopeId === targetId)) {
      ctx.knowledge.unbindNotebook(binding.notebookId, {
        scopeType: 'waker',
        scopeId: targetId,
      });
    }
  }
}

export function importAgentPackage(
  ctx: AppContext,
  zipData: Buffer,
  options: { agentId?: string; mode: 'dry-run' | 'apply'; conflict: 'error' | 'overwrite' },
): AgentPackageImportReport {
  if (!zipData.length) throw new PackageImportError(400, '请求体为空（应为 ZIP 整包）');
  const parsed = parsePackage(zipData);
  const targetId = options.agentId ?? parsed.manifest.agentId;
  if (!AGENT_ID_REGEX.test(targetId)) {
    throw new PackageImportError(400, `目标 Agent id 不合法：${targetId}`);
  }
  const targetExists = loadAgents(ctx.cwd).some((agent) => agent.id === targetId);
  if (targetExists && options.conflict !== 'overwrite') {
    throw new PackageImportError(
      409,
      `Agent 已存在：${targetId}（需要覆盖请使用 conflict=overwrite）`,
    );
  }

  const skipped: AgentPackageImportReport['skipped'] = [];
  const failures: AgentPackageImportReport['failures'] = [];
  if (parsed.invalidAvatar) {
    skipped.push({ kind: 'avatar', id: 'avatar', reason: '头像不是合法的 PNG/JPG 图片' });
  }
  // 兼容缺少 includes 的 manifest：按包内实际数据推导需要覆盖清理的类别。
  const includes: Partial<PackageIncludes> = isRecord(parsed.manifest.includes)
    ? parsed.manifest.includes
    : {
        avatar: Boolean(parsed.avatar),
        memories: parsed.memories.length > 0,
        projects: parsed.projects.length > 0,
        automations: parsed.automations.length > 0,
        workflows: parsed.workflows.length > 0,
        connectors: parsed.connectors.length > 0,
        preferences:
          parsed.preferences.thinking !== undefined || parsed.preferences.model !== undefined,
        knowledgeBindings: parsed.knowledgeBindings.length > 0,
      };

  // 偏好与绑定在 plan 阶段就能判定是否可落地（不依赖写入）。
  const thinkingValue = parsed.preferences.thinking;
  const thinkingApplicable =
    thinkingValue !== undefined &&
    typeof thinkingValue === 'string' &&
    (AGENT_THINKING_LEVELS as readonly string[]).includes(thinkingValue);
  if (thinkingValue !== undefined && !thinkingApplicable) {
    skipped.push({ kind: 'preference', id: 'thinking', reason: 'thinking 档位不合法' });
  }
  const modelValue = parsed.preferences.model;
  const availableModels = listCodexModels(ctx.cwd);
  const modelApplicable =
    modelValue !== undefined &&
    typeof modelValue === 'string' &&
    availableModels.some((model) => model.id === modelValue);
  if (modelValue !== undefined && !modelApplicable) {
    skipped.push({ kind: 'preference', id: 'model', reason: '模型不在可用列表内' });
  }
  const existingNotebooks = new Set(ctx.knowledge.listNotebooks().map((item) => item.id));
  const applicableBindings = parsed.knowledgeBindings.filter((binding) => {
    if (!existingNotebooks.has(binding.notebookId)) {
      skipped.push({
        kind: 'knowledge-binding',
        id: binding.notebookId,
        reason: `目标机不存在 notebook：${binding.notebookName || binding.notebookId}`,
      });
      return false;
    }
    return true;
  });

  const report: AgentPackageImportReport = {
    mode: options.mode,
    agentId: targetId,
    agentName: parsed.agentName,
    action: targetExists ? 'overwrite' : 'create',
    strippedFrontmatter: parsed.strippedFrontmatter,
    contents: {
      avatar: Boolean(parsed.avatar),
      memories: parsed.memories.length,
      projects: parsed.projects.length,
      automations: parsed.automations.length,
      workflows: parsed.workflows.length,
      connectors: parsed.connectors.length,
      preferences: (thinkingApplicable ? 1 : 0) + (modelApplicable ? 1 : 0),
      knowledgeBindings: applicableBindings.length,
    },
    skipped,
    failures,
  };
  if (options.mode === 'dry-run') return report;

  // --- apply -------------------------------------------------------------------
  if (targetExists) {
    clearIncludedData(ctx, targetId, includes);
    deleteAgent(ctx.cwd, targetId);
  }
  try {
    // importAgent 与 createAgent 共用序列化器：未知 frontmatter 字段天然不落地。
    importAgent(ctx.cwd, { id: targetId, content: parsed.agentMarkdown });
  } catch (error) {
    if (error instanceof AgentCreateError) {
      throw new PackageImportError(error.code === 'CONFLICT' ? 409 : 400, error.message);
    }
    throw error;
  }

  if (parsed.avatar) {
    try {
      writeAgentAvatar(ctx.cwd, targetId, parsed.avatar);
    } catch (error) {
      skipped.push({
        kind: 'avatar',
        id: 'avatar',
        reason: error instanceof Error ? error.message : '头像写入失败',
      });
      report.contents.avatar = false;
    }
  }

  const scope = { type: 'waker' as const, id: targetId };
  for (const document of parsed.memories) {
    try {
      // 重新生成 id；scope 改写为导入目标的 waker scope。
      ctx.memory.create({
        scope,
        source: document.source,
        title: document.title,
        content: document.content,
      });
    } catch (error) {
      failures.push({
        kind: 'memory',
        id: document.title,
        error: error instanceof Error ? error.message : '写入失败',
      });
    }
  }

  const projectIdMap = new Map<string, string>();
  for (const project of parsed.projects) {
    try {
      const created = ctx.workspaceData.createProject({
        wakerId: targetId,
        visibility: project.visibility,
        name: project.name,
        description: project.description,
        source: project.source,
        // syncing 是运行时瞬态，导入后按 idle 落地。
        status: project.status === 'syncing' ? 'idle' : project.status,
        path: project.path,
        error: project.status === 'error' ? project.error : null,
      });
      projectIdMap.set(project.id, created.id);
    } catch (error) {
      failures.push({
        kind: 'project',
        id: project.name,
        error: error instanceof Error ? error.message : '写入失败',
      });
    }
  }
  const mapProjectId = (projectId: string | null | undefined): string | null =>
    projectId ? (projectIdMap.get(projectId) ?? null) : null;

  for (const automation of parsed.automations) {
    try {
      ctx.workspaceData.createAutomation({
        wakerId: targetId,
        name: automation.name,
        kind: automation.kind,
        prompt: automation.prompt,
        schedule: automation.schedule,
        enabled: automation.enabled,
        timezone: automation.timezone,
        startAt: automation.startAt,
        endAt: automation.endAt,
        maxRuns: automation.maxRuns,
        misfirePolicy: automation.misfirePolicy as MisfirePolicy,
        projectId: mapProjectId(automation.projectId),
        model: automation.model,
        thinking: automation.thinking as AutomationThinkingLevel | null,
      });
    } catch (error) {
      failures.push({
        kind: 'automation',
        id: automation.name,
        error: error instanceof Error ? error.message : '写入失败',
      });
    }
  }

  for (const workflow of parsed.workflows) {
    try {
      ctx.workspaceData.createWorkflow({
        wakerId: targetId,
        name: workflow.name,
        description: workflow.description,
        definition: workflow.definition ?? undefined,
        script: workflow.definition ? undefined : workflow.script,
        // 'error' 是运行时状态，导入后回到 draft。
        status: workflow.status === 'error' ? 'draft' : (workflow.status as Exclude<WorkflowStatus, 'error'>),
        projectId: mapProjectId(workflow.projectId),
        model: workflow.model,
        thinking: workflow.thinking,
      });
    } catch (error) {
      failures.push({
        kind: 'workflow',
        id: workflow.name,
        error: error instanceof Error ? error.message : '写入失败',
      });
    }
  }

  for (const connector of parsed.connectors) {
    try {
      ctx.workspaceData.createConnector({
        wakerId: targetId,
        name: connector.name,
        transport: connector.transport,
        status: connector.status,
        command: connector.command,
        url: connector.url,
        metadata: connector.metadata,
        tools: connector.tools,
      });
    } catch (error) {
      failures.push({
        kind: 'connector',
        id: connector.name,
        error: error instanceof Error ? error.message : '写入失败',
      });
    }
  }

  if (thinkingApplicable) setPreference(ctx.cwd, `thinking.${targetId}`, thinkingValue);
  if (modelApplicable) setPreference(ctx.cwd, `model.${targetId}`, modelValue);
  for (const binding of applicableBindings) {
    try {
      ctx.knowledge.bindNotebook(
        binding.notebookId,
        { scopeType: 'waker', scopeId: targetId },
        binding.canWrite,
      );
    } catch (error) {
      failures.push({
        kind: 'knowledge-binding',
        id: binding.notebookId,
        error: error instanceof Error ? error.message : '写入失败',
      });
    }
  }

  return report;
}
