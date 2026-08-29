/** Thinking is an explicit per-request capability, never inferred from the user message. */
export type AgentThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

/** Agent ids come from the Markdown filename under .codex/agents. */
export const AGENT_ID_PATTERN = '^[a-z][a-z0-9-]{1,63}$';

export interface AgentSummary {
  id: string;
  name: string;
  /** Avatar initials rendered by the Web client. */
  mark: string;
  tagline: string;
  description: string;
  /** Suggested questions shown on the welcome screen. */
  suggestions: string[];
  /** Persisted session count; only populated by the workspace endpoint. */
  sessionCount?: number;
  /** Unread attention sessions (needsAttention && !completedAt && !read); workspace endpoint only. */
  unreadCount?: number;
  /** True when .codex/agents/<id>.avatar.<ext> exists; the avatar is served at /agents/<id>/avatar. */
  hasAvatar?: boolean;
}

/** One titled item of the optional 关于我 profile sections (我最擅长 / 工作风格). */
export interface AgentProfileSectionItem {
  title: string;
  text: string;
}

/** Payload for POST /api/v1/agents; creates .codex/agents/<id>.md. */
export interface CreateAgentRequest {
  /** Optional explicit id; derived from `name` when omitted. */
  id?: string;
  name: string;
  mark: string;
  tagline: string;
  description: string;
  suggestions: string[];
  /** System-prompt body written after the YAML frontmatter. */
  body: string;
  /** Optional 我最擅长 section items carried by role templates. */
  strengths?: AgentProfileSectionItem[];
  /** Optional 工作风格 section items carried by role templates. */
  workStyles?: AgentProfileSectionItem[];
}

/** Payload for POST /api/v1/agents/import; imports one complete Markdown definition file. */
export interface ImportAgentRequest {
  /** Agent id taken from the source filename; remains immutable after import. */
  id: string;
  /** Full Markdown source including YAML frontmatter and the system-prompt body. */
  content: string;
}

/** Payload for PATCH /api/v1/agents/:agentId; rewrites .codex/agents/<id>.md keeping untouched fields. */
export interface UpdateAgentRequest {
  name?: string;
  mark?: string;
  tagline?: string;
  description?: string;
  suggestions?: string[];
  /** System-prompt body written after the YAML frontmatter. */
  body?: string;
}

/** AgentDetail adds the system-prompt body for the configure panel. */
export interface AgentDetail extends AgentSummary {
  /** Markdown body of .codex/agents/<id>.md; used as the agent's system prompt. */
  body: string;
  /** Optional avatar file name (`.codex/agents/<id>.avatar.<ext>`), kept in the frontmatter. */
  avatar?: string;
  /** Optional 我最擅长 section items from the frontmatter; rendered on the Waker home view. */
  strengths?: AgentProfileSectionItem[];
  /** Optional 工作风格 section items from the frontmatter; rendered on the Waker home view. */
  workStyles?: AgentProfileSectionItem[];
  /** Project-relative path of the definition file. */
  path: string;
}

/** Payload of PUT /api/v1/agents/:agentId/avatar; the image is validated by magic bytes (PNG/JPG, ≤2MB). */
export interface UploadAgentAvatarRequest {
  mimeType: 'image/png' | 'image/jpeg';
  /** Base64-encoded image bytes; 2MB binary expands to roughly 2.8MB Base64. */
  dataBase64: string;
}

export interface AgentDeleteImpact {
  agentId: string;
  sessions: number;
  projects: number;
  automations: number;
  workflows: number;
  tasks: number;
  humanActions: number;
  connectors: number;
  sharedSkills: number;
  behavior: {
    definition: 'delete';
    sessions: 'delete';
    projects: 'delete-record-only';
    board: 'soft-delete-history';
    connectors: 'delete';
    skills: 'shared-preserve';
  };
}

/** Payload of GET /api/v1/agents/:agentId/home; real per-agent stats for the Waker home view. */
export interface AgentHomeResponse {
  /** Birthtime of the agent definition file; null when the filesystem cannot provide it. */
  createdAt: string | null;
  counts: {
    sessions: number;
    questions: number;
    automations: number;
    projects: number;
    workflows: number;
    tasks: number;
  };
  /** Per-day counts of sessions by updated_at (SQLite date()), ascending by date. */
  activity: Array<{ date: string; count: number }>;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Number of user questions recorded in the Codex rollout session. */
  questionCount: number;
  /** True when the session's last assistant message ended in an error or was aborted. */
  needsAttention: boolean;
  /** stopReason of that last assistant message, when needsAttention is true. */
  attentionReason?: 'error' | 'aborted';
  /** Provider error message recorded on that message, when available. */
  attentionDetail?: string;
  /** 收件箱预览：最后一条 assistant 文本（无则最后一条 user 文本），压缩成单行并截断；为空时省略。 */
  preview?: string;
}

/** Payload of GET /api/v1/agents/:agentId/sessions. */
export interface SessionListResponse {
  items: SessionSummary[];
  total: number;
}

/** 收件箱分段：Needs Attention / Completed / All。 */
export type InboxTab = 'attention' | 'completed' | 'all';

/** 收件箱条目：SessionSummary 叠加 sessions 表里的已读/完成状态。 */
export interface InboxItem extends SessionSummary {
  /** 已读 = 用户已查看且此后没有新的出错/中断。 */
  read: boolean;
  /** 被标记完成（或出错/中断后又有成功运行）的时间；未完成为 undefined。 */
  completedAt?: string;
}

/** Payload of GET /api/v1/inbox; items 按 tab 过滤、updatedAt 倒序。 */
export interface InboxResponse {
  items: InboxItem[];
  total: number;
  /** attention tab 中未读条数；不受 q 过滤影响。 */
  unreadCount: number;
}

/** Payload of PATCH /api/v1/agents/:agentId/sessions/:sessionId/inbox; 至少一个字段。 */
export interface UpdateInboxStateRequest {
  read?: boolean;
  completed?: boolean;
}

/** Payload of POST /api/v1/inbox/read-all; 被标记已读的未读 attention 会话数。 */
export interface InboxReadAllResponse {
  updated: number;
}

/** Payload of PATCH /api/v1/agents/:agentId/sessions/:sessionId. */
export interface RenameSessionRequest {
  title: string;
}

/** A browser-held attachment uploaded atomically with one chat turn. */
export interface ChatInlineAttachment {
  originalName: string;
  mimeType: string;
  dataBase64: string;
}

export interface ChatRequest {
  agentId: string;
  sessionId?: string;
  message: string;
  /** Optional model override; the API validates it against the provider catalog. */
  model?: string;
  /** Optional per-turn thinking level. */
  thinking?: AgentThinkingLevel;
  /** Existing session attachment ids to include in this turn (max 8). */
  attachmentIds?: string[];
  /** Browser-held attachments imported into the target session before this turn (combined max 8). */
  attachments?: ChatInlineAttachment[];
  /** Optional local project context selected from the server-owned project catalog. */
  projectId?: string;
}

export interface ChatModelLabel {
  provider?: string;
  model?: string;
  thinkingLevel: AgentThinkingLevel;
}

export interface ChatUsage {
  input: number;
  output: number;
  total: number;
}

/** One traceable knowledge chunk retrieved for a chat turn. */
export interface ChatCitationSource {
  index: number;
  notebookId: string;
  documentId: string;
  documentVersion: number;
  chunkId: string;
  title: string;
  uri?: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  matchMode: KnowledgeSearchMode | 'keyword_fallback';
  score: number;
  keywordScore?: number;
  vectorScore?: number;
}

export type ChatProcessStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** One compact, inspectable tool or plan step associated with an assistant turn. */
export interface ChatProcess {
  id: string;
  name: string;
  args?: string;
  result?: string;
  status: ChatProcessStatus;
}

/** Stable server-side classification of a failed chat turn (QoderWake-style red card kinds). */
export type ChatErrorKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'startup'
  | 'generic';

/** One message replayed from a persisted Codex rollout session. */
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Reasoning trace recorded on assistant messages, when the turn used thinking. */
  thinking?: string;
  usage?: ChatUsage;
  /** Codex turn status of assistant messages; 'error' / 'aborted' mark failed turns. */
  stopReason?: string;
  errorMessage?: string;
  /** Classification of the failed turn, derived from the persisted error message. */
  errorKind?: ChatErrorKind;
  /** Quota reset hint extracted from the provider message, when present. */
  errorResetAt?: string;
  /** Knowledge chunks used for this assistant turn, reconstructed from the persisted prompt. */
  sources?: ChatCitationSource[];
  /** Tool and plan activity reconstructed from the persisted Codex rollout. */
  tools?: ChatProcess[];
  timestamp: string;
}

/** Payload of GET /api/v1/agents/:agentId/sessions/:sessionId/messages. */
export interface SessionMessagesResponse {
  items: SessionMessage[];
}

/** Payloads transported by the POST /api/v1/chat SSE endpoint. */
export type ChatStreamEvent =
  | { type: 'start'; sessionId: string; agentId: string; model: ChatModelLabel }
  | { type: 'sources'; sources: ChatCitationSource[] }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  /**
   * 工具执行生命周期帧（subagent 委派、bash 等工具卡片用）。
   * args/result 是截断后的 JSON 文本（API 侧 4KB 上限），可能不是完整 JSON，渲染按纯文本处理。
   */
  | {
      type: 'tool';
      phase: 'start' | 'update' | 'end';
      toolCallId: string;
      toolName: string;
      args?: string;
      result?: string;
      isError?: boolean;
    }
  | { type: 'done'; answer: string; usage?: ChatUsage }
  | { type: 'error'; error: string; kind?: ChatErrorKind; resetAt?: string };

/** Project resources visible to an agent plus its persisted run statistics. */
export interface AgentResources {
  /** .codex/prompts templates merged into the project context. */
  prompts: PromptSummary[];
  /** Runtime-available repo `.agents/skills` entries shared by every Waker. */
  skills: SkillSummary[];
  /** True when .codex/APPEND_SYSTEM.md exists and is appended to every agent's context. */
  appendSystem: boolean;
  stats: {
    /** Persisted session count bound to this agent. */
    sessionCount: number;
    /** Total user questions recorded across those sessions. */
    questionCount: number;
  };
}

export interface PromptSummary {
  name: string;
  /** Project-relative path, e.g. .codex/prompts/inspect-pi.md */
  path: string;
  description?: string;
  /** First characters of the body with frontmatter stripped; shown on the Skills page. */
  preview?: string;
}

/** One runtime-available repo `.agents/skills/<dir>/SKILL.md` entry. */
export interface SkillSummary {
  name: string;
  /** Project-relative path, e.g. .codex/skills/research/SKILL.md */
  path: string;
  description?: string;
  /** First characters of the body with frontmatter stripped. */
  preview?: string;
}

export interface PromptDocument extends PromptSummary {
  /** Markdown body with the YAML frontmatter stripped. */
  content: string;
}

/** Payload of PUT /api/v1/prompts/:name; rewrites .codex/prompts/<name>.md keeping other frontmatter fields. */
export interface UpdatePromptRequest {
  /** Markdown body written after the YAML frontmatter. */
  content: string;
  /** Replaces the frontmatter description when present; omitted keeps the current one. */
  description?: string;
}

/** Payload of GET /api/v1/append-system; null when .codex/APPEND_SYSTEM.md is not configured. */
export interface AppendSystemResponse {
  content: string | null;
}

/** Payload of PUT /api/v1/append-system; an empty (trimmed) content removes the file. */
export interface UpdateAppendSystemRequest {
  content: string;
}

/** Payload of GET /api/v1/skills; items are the compact repo-skill projection. */
export interface SkillListResponse {
  items: SkillSummary[];
  total: number;
}

/** One entry of the skills.sh library (top list or search hit). */
export interface LibrarySkillSummary {
  /** skills.sh 详情页路径三段式 id，e.g. "vercel-labs/skills/find-skills"。 */
  id: string;
  name: string;
  /** GitHub 仓库 "owner/repo"。 */
  source: string;
  /** 总安装量（从紧凑字符串如 "3.1M" 解析；搜索接口无此字段时为 0）。 */
  installs: number;
  /** 最近 8 周安装量 sparkline（仅榜单模式有）。 */
  weeklyInstalls?: number[];
  /** 榜单排名（仅榜单模式有，从 1 开始）。 */
  rank?: number;
  /** 描述（搜索接口不提供，榜单首页也没有；预留详情页 og:description）。 */
  description?: string;
  /** 已在本地 .agents/skills 或 .codex/skills 安装（按 name 匹配）。 */
  installed: boolean;
}

/** Payload of GET /api/v1/skills/library; mode 区分榜单与搜索。 */
export interface SkillLibraryResponse {
  items: LibrarySkillSummary[];
  total: number;
  mode: 'top' | 'search';
}

/** Repo runtime skill or an explicitly marked legacy host source. */
export interface InstalledSkillSummary {
  /** Stable inventory identity; names are not unique across skill scopes. */
  locator: string;
  name: string;
  description?: string;
  /** Optional skill-authored version from SKILL.md frontmatter. */
  version?: string;
  /** 正文预览（frontmatter 剥离后的前 200 字符）。 */
  preview?: string;
  /** skills-lock.json 里的 "owner/repo"；.codex/skills 条目无此字段。 */
  source?: string;
  /** 'agents' is repo scope; 'codex' is the project CODEX_HOME host scope. */
  scope: 'codex' | 'agents';
  /** 项目相对路径，e.g. .agents/skills/research/SKILL.md */
  path: string;
  /** Both supported scopes are discovered by this Waker runtime when valid. */
  availability: 'available';
  /** True only when the Skills CLI lockfile owns this repo skill. */
  managed: boolean;
  valid: boolean;
  errors: string[];
  allowImplicitInvocation: boolean;
  dependencies: SkillDependencySummary[];
  files: SkillFileSummary[];
  lock?: SkillLockMetadata;
  /** Lock hashes are informative until the Skills CLI exposes a compatible verifier. */
  integrity: 'ok' | 'drift' | 'unverified' | 'unmanaged';
}

export interface SkillDependencySummary {
  type: string;
  value: string;
  description?: string;
}

export interface SkillFileSummary {
  path: string;
  size: number;
  executable: boolean;
  symlink: boolean;
}

export interface SkillLockMetadata {
  version: number;
  source?: string;
  sourceType?: string;
  skillPath?: string;
  computedHash?: string;
  commit?: string;
}

/** Payload of GET /api/v1/skills/installed。 */
export interface InstalledSkillListResponse {
  items: InstalledSkillSummary[];
  total: number;
}

/** Payload of POST /api/v1/skills/install；source 需匹配 owner/repo，skillId 为单段 slug。 */
export interface SkillInstallRequest {
  /** `^[a-z0-9_.-]+/[a-z0-9_.-]+$`，API 侧再校验一次（execFile 参数数组，无 shell 拼接）。 */
  source: string;
  /** `^[a-z0-9_.-]+$`。 */
  skillId: string;
}

/** Payload of POST /api/v1/skills/remove；name 为已安装技能名。 */
export interface SkillRemoveRequest {
  /** `^[a-z0-9_.-]+$`。 */
  name: string;
  /** Required stable target because names may repeat across scopes. */
  locator: string;
  /**
   * 删除范围：'codex' = legacy .codex/skills/<name>/ 直接删目录，
   * 'agents' = .agents/skills 走 npx skills remove；省略时按已安装列表查找。
   */
  scope?: 'codex' | 'agents';
}

/** Payload of POST /api/v1/skills/upload：stage source, then install via Skills CLI. */
export interface UploadSkillRequest {
  /** 目录名/技能名：`^[a-z0-9-]{1,80}$`。 */
  name: string;
  /** Complete instruction-only SKILL.md; name + description frontmatter is required (≤128KB). */
  content: string;
  description?: string;
}

/** Payload of GET /api/v1/skills/installed/content：一个已安装技能的完整定义。 */
export interface InstalledSkillContent {
  locator: string;
  name: string;
  description?: string;
  version?: string;
  source?: string;
  scope: 'codex' | 'agents';
  /** SKILL.md 正文（frontmatter 已剥离，trim 后）。 */
  content: string;
  /** 原始 frontmatter 文本（不含 --- 分隔线）；无 frontmatter 时省略。 */
  frontmatter?: string;
  valid: boolean;
  errors: string[];
  allowImplicitInvocation: boolean;
  dependencies: SkillDependencySummary[];
  files: SkillFileSummary[];
  integrity: InstalledSkillSummary['integrity'];
}

/** Payload of GET /api/v1/skills/library/detail：skills.sh 详情页解析结果。 */
export interface LibrarySkillDetail {
  /** skills.sh 三段式 id，e.g. "vercel-labs/skills/find-skills"。 */
  id: string;
  name: string;
  source: string;
  /** og:description（HTML 实体已解码；skills.sh 自身可能以 … 截断）。 */
  description?: string;
  /** 详情页侧栏的总安装量（紧凑字符串解析；缺失时省略）。 */
  installs?: number;
  /** skills.sh is a third-party discovery source, not an OpenAI trust decision. */
  thirdParty: true;
  /** The current endpoint cannot review the repository files before explicit install. */
  contentReviewed: false;
  riskNotice: string;
}

/** One entry of GET /api/v1/files; 目录排前、按名称排序。 */
export interface FileEntry {
  name: string;
  kind: 'file' | 'directory';
  /** Byte size；目录恒为 0。 */
  size: number;
}

/** Payload of GET /api/v1/files?path=（只读项目文件浏览）。 */
export interface FileListResponse {
  /** 相对仓库根的路径；仓库根为空串。 */
  path: string;
  entries: FileEntry[];
}

/** Payload of GET /api/v1/files/content?path=；内容上限 256KB。 */
export interface FileContentResponse {
  /** 相对仓库根的路径。 */
  path: string;
  content: string;
  /** 超过 256KB 被截断时为 true。 */
  truncated: boolean;
}

export interface WorkspaceResponse {
  agents: AgentSummary[];
  prompts: PromptSummary[];
  /** 本机环境信息：本地模式只有一台机器，即 API 进程所在主机。 */
  host: { name: string };
  models: {
    current: { provider?: string; model?: string };
    available: Array<{ id: string; name: string }>;
  };
}

/** Token totals aggregated from Codex rollout token_count records. */
export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

/** One row of the per-agent usage table on the Usage page. */
export interface AgentUsageRow {
  agentId: string;
  name: string;
  mark: string;
  sessionCount: number;
  questionCount: number;
  /** Token totals recorded for this agent; zeros when no turn has been recorded yet. */
  tokens: TokenTotals;
  /** Most recent updatedAt across this agent's sessions; absent when it has none. */
  lastActiveAt?: string;
}

/** Payload of GET /api/v1/usage; session/question numbers come from the session store, tokens from rollout files. */
export interface UsageResponse {
  totalSessions: number;
  totalQuestions: number;
  agentCount: number;
  /**
   * Questions from sessions created or updated on the current local day.
   * Approximation: SessionSummary has no per-question timestamps.
   */
  questionsToday: number;
  /** Global token totals across all recorded chat turns. */
  tokens: TokenTotals;
  perAgent: AgentUsageRow[];
}

/** Payload of GET /api/v1/settings; non-sensitive configuration only, never credentials. */
export interface SettingsResponse {
  model: {
    provider?: string;
    model?: string;
    available: Array<{ id: string; name: string }>;
  };
  /** Default thinking level from CODEX_REASONING_EFFORT / .codex/settings.json. */
  thinkingLevel: AgentThinkingLevel;
  resources: {
    agents: number;
    prompts: number;
    skills: number;
    /** True when .codex/APPEND_SYSTEM.md exists. */
    appendSystem: boolean;
  };
  workspace: {
    /** Basename of the project root, e.g. "pi-samples". */
    name: string;
    /** Session storage path relative to the project root, e.g. ".codex/sessions". */
    sessionDir: string;
  };
  security: {
    codexEnabled: boolean;
    sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
    /** Host policy is authoritative; Agent files and browser requests cannot expand it. */
    managedByHost: true;
  };
}

/** Payload of GET /api/v1/agent-templates (and /api/v1/templates); parsed from .codex/agent-templates/<id>.md. */
export interface AgentTemplate {
  id: string;
  name: string;
  mark: string;
  tagline: string;
  description: string;
  suggestions: string[];
  body: string;
  /** Optional 我最擅长 section items; carried over when an agent is created from the template. */
  strengths?: AgentProfileSectionItem[];
  /** Optional 工作风格 section items; carried over when an agent is created from the template. */
  workStyles?: AgentProfileSectionItem[];
}

export interface AgentTemplatesResponse {
  items: AgentTemplate[];
}

/** Payload of GET /api/v1/preferences; keys are namespaced (ui.*, thinking.<agentId>). */
export interface PreferencesResponse {
  items: Record<string, unknown>;
}

/** Payload of PUT /api/v1/preferences; upserts one namespaced key. */
export interface PreferenceUpdateRequest {
  key: string;
  value: unknown;
}

/** Local-first knowledge domain. SQLite is the source of truth. */
export type KnowledgeScope = { kind: 'waker' | 'project'; id: string };
export type KnowledgeAccessMode = 'read_only' | 'read_write';
export type KnowledgeSearchMode = 'keyword' | 'vector' | 'hybrid';

export interface KnowledgeNotebook {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
}

export interface KnowledgeDocument {
  id: string;
  notebookId: string;
  title: string;
  uri?: string;
  mimeType: string;
  sourceType: 'text' | 'markdown' | 'file' | 'web';
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBinding {
  notebookId: string;
  scope: KnowledgeScope;
  access: KnowledgeAccessMode;
  createdAt: string;
}

export interface KnowledgeSearchResult {
  notebookId: string;
  documentId: string;
  documentVersion: number;
  chunkId: string;
  title: string;
  uri?: string;
  startLine: number;
  endLine: number;
  content: string;
  snippet: string;
  keywordScore?: number;
  vectorScore?: number;
  score: number;
  citation: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
  modeUsed: KnowledgeSearchMode | 'keyword_fallback';
  degraded: boolean;
  reason?: string;
  total: number;
  truncated: boolean;
}

export interface CreateKnowledgeNotebookRequest {
  title: string;
  description?: string;
}

export interface UpsertKnowledgeDocumentRequest {
  id?: string;
  notebookId: string;
  title: string;
  uri?: string;
  mimeType?: string;
  sourceType?: KnowledgeDocument['sourceType'];
  content: string;
  expectedVersion?: number;
}

/** Payload of POST /api/v1/knowledge/documents/import-url; the API fetches each URL itself. */
export interface ImportKnowledgeUrlsRequest {
  notebookId: string;
  urls: string[];
  scope?: KnowledgeScope;
}

export interface KnowledgeUrlImportResult {
  url: string;
  ok: boolean;
  documentId?: string;
  title?: string;
  error?: string;
}

export interface ImportKnowledgeUrlsResponse {
  results: KnowledgeUrlImportResult[];
  imported: number;
  failed: number;
}

export interface KnowledgeSearchRequest {
  scope: KnowledgeScope;
  query: string;
  mode: KnowledgeSearchMode;
  notebookId?: string;
  limit?: number;
  minScore?: number;
}

export type ProjectVisibility = 'private' | 'public';
export type ProjectStatus = 'ready' | 'initializing' | 'error';

export interface WakerProject {
  id: string;
  wakerId: string;
  name: string;
  description?: string;
  visibility: ProjectVisibility;
  source: 'filesystem' | 'git';
  path: string;
  status: ProjectStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDeleteImpact {
  projectId: string;
  sessionContexts: number;
  tasks: number;
  tasksPreserved: number;
  automationDefinitions: number;
  automationRuns: number;
  automationTasksPreserved: number;
  workflowDefinitions: number;
  workflowRuns: number;
  behavior: {
    sessionContexts: 'delete';
    tasks: 'detach-and-preserve';
    automationDefinitions: 'detach-and-pause';
    automationTasks: 'preserve';
    workflowDefinitions: 'detach-and-pause';
    workflowRuns: 'preserve';
  };
}

export interface WakerAutomation {
  id: string;
  wakerId: string;
  name: string;
  kind: 'schedule' | 'api' | 'event';
  schedule?: string;
  prompt: string;
  projectId?: string;
  model?: string;
  thinking?: AgentThinkingLevel;
  enabled: boolean;
  lifecycle: 'active' | 'paused' | 'completed';
  timezone: string;
  startAt?: string;
  endAt?: string;
  maxRuns?: number;
  runCount: number;
  misfirePolicy: 'run_once' | 'skip';
  lastRunAt?: string;
  lastScheduledAt?: string;
  nextRunAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowJsonValue =
  null | boolean | number | string | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };

export interface WorkflowNodeBase {
  id: string;
  name?: string;
}

export type WorkflowNode =
  | (WorkflowNodeBase & {
      kind: 'action';
      action: 'set';
      key: string;
      value: WorkflowJsonValue;
      next: string;
    })
  | (WorkflowNodeBase & {
      kind: 'codex';
      prompt: string;
      wakerId?: string;
      projectId?: string;
      model?: string;
      thinking?: AgentThinkingLevel;
      outputKey?: string;
      next: string;
    })
  | (WorkflowNodeBase & {
      kind: 'decision';
      key: string;
      branches: { equals: null | boolean | number | string; next: string }[];
      defaultNext: string;
    })
  | (WorkflowNodeBase & { kind: 'wait'; durationMs: number; next: string })
  | (WorkflowNodeBase & { kind: 'ask_user'; prompt: string; inputKey: string; next: string })
  | (WorkflowNodeBase & {
      kind: 'call_workflow';
      workflowId: string;
      input?: WorkflowJsonValue;
      outputKey?: string;
      next: string;
    })
  | (WorkflowNodeBase & {
      kind: 'terminal';
      status: 'succeeded' | 'failed';
      output?: WorkflowJsonValue;
    });

export interface WorkflowDefinition {
  schemaVersion: 1;
  start: string;
  nodes: WorkflowNode[];
}

export interface WakerWorkflowSummary {
  id: string;
  wakerId: string;
  projectId?: string;
  model?: string;
  thinking?: AgentThinkingLevel;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'paused' | 'error';
  version: number;
  nodeCount: number;
  validationErrors: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WakerWorkflow extends WakerWorkflowSummary {
  script: string;
  definition?: WorkflowDefinition;
}

export interface WorkflowVersionRecord {
  workflowId: string;
  version: number;
  wakerId: string;
  projectId?: string;
  model?: string;
  thinking?: AgentThinkingLevel;
  name: string;
  description?: string;
  definition?: WorkflowDefinition;
  status: 'draft' | 'active' | 'paused' | 'error';
  validationErrors: string[];
  operation: 'create' | 'update' | 'rollback' | 'legacy';
  createdAt: string;
}

export interface WorkflowVersionListResponse {
  items: WorkflowVersionRecord[];
  total: number;
}

export interface WorkflowValidationResponse {
  valid: boolean;
  definition?: WorkflowDefinition;
  script?: string;
  errors: string[];
}

export interface WorkflowValidationRequest {
  wakerId: string;
  workflowId?: string;
  script: string;
}

export interface WorkflowGenerateDefinitionRequest {
  description: string;
  model?: string;
}

export interface WorkflowGenerateDefinitionResponse {
  definition: WorkflowDefinition;
}

export interface WorkflowMutationResponse {
  applied: boolean;
  workflow: WakerWorkflow;
  diff: string;
}

export interface WorkflowDeleteImpactRecord {
  workflowId: string;
  versions: number;
  runs: number;
  activeRuns: number;
  referencedBy: string[];
  behavior: {
    definition: 'soft-delete';
    versions: 'preserve';
    runs: 'preserve';
  };
}

export interface WakerChannel {
  id: string;
  provider: 'local' | 'dingtalk' | 'feishu' | 'weixin' | 'wecom' | 'qq';
  name: string;
  status: 'connected' | 'stopped' | 'disabled' | 'error';
  config: Record<string, string | number | boolean>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type BoardTaskStatus =
  'queued' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';
export type BoardTaskType = 'manual' | 'conversation' | 'automation' | 'workflow';
export type BoardTaskSourceType = 'manual' | 'conversation' | 'automation' | 'workflow';
export type BoardTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface WakerTask {
  id: string;
  wakerId: string;
  title: string;
  description: string;
  type: BoardTaskType;
  origin: 'manual' | 'derived';
  managed: boolean;
  status: BoardTaskStatus;
  priority: BoardTaskPriority;
  position: number;
  version: number;
  projectId?: string;
  sourceType: BoardTaskSourceType;
  sourceId: string;
  source: string;
  runId?: string;
  sessionId?: string;
  parentTaskId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BoardTaskEventRecord {
  id: number;
  taskId: string;
  sequence: number;
  type: string;
  status?: BoardTaskStatus;
  payload?: unknown;
  createdAt: string;
}

export interface BoardTaskListResponse {
  items: WakerTask[];
  total: number;
  limit: number;
  offset: number;
}

export interface BoardTaskDetailResponse {
  task: WakerTask;
  events: BoardTaskEventRecord[];
  children: WakerTask[];
  humanActions: HumanActionRecord[];
}

export interface BoardTaskDeleteImpactRecord {
  taskId: string;
  children: number;
  events: number;
  humanActions: number;
  behavior: 'soft-delete';
}

export interface LocalResourcesResponse {
  projects: WakerProject[];
  automations: WakerAutomation[];
  workflows: WakerWorkflowSummary[];
  channels: WakerChannel[];
  tasks: WakerTask[];
}

export type MemoryScopeType = 'waker' | 'project' | 'group';
export interface MemoryScope {
  type: MemoryScopeType;
  id: string;
}

export interface MemoryDocument {
  id: string;
  scope: MemoryScope;
  source: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersion {
  id: string;
  documentId: string;
  version: number;
  title: string;
  source: string;
  content: string;
  deleted: boolean;
  operation: string;
  createdAt: string;
}

export interface MemorySnapshot {
  id: string;
  documentId: string;
  versionId: string;
  operation: string;
  createdAt: string;
}

export interface MemoryTimelineEntry {
  id: number;
  documentId: string;
  scope: MemoryScope;
  source: string;
  action: string;
  status: string;
  version: number;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  taskId: string;
  wakerId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  trigger: 'manual' | 'scheduled';
  scheduledFor?: string;
  nameSnapshot: string;
  promptSnapshot: string;
  projectId?: string;
  sessionId?: string;
  model?: string;
  thinking?: AgentThinkingLevel;
  input?: unknown;
  output?: unknown;
  result?: string;
  usage?: ChatUsage;
  error?: string;
  attempt: number;
  retryOfRunId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowRunRecord {
  id: string;
  taskId: string;
  workflowId: string;
  workflowVersion: number;
  nameSnapshot: string;
  descriptionSnapshot: string;
  scriptSnapshot: string;
  definitionSnapshot?: WorkflowDefinition;
  wakerId: string;
  projectId?: string;
  model?: string;
  thinking?: AgentThinkingLevel;
  sessionId?: string;
  parentRunId?: string;
  parentNodeId?: string;
  childRunId?: string;
  depth: number;
  attempt: number;
  retryOfRunId?: string;
  currentNodeId?: string;
  context: Record<string, unknown>;
  wakeAt?: string;
  waitingActionId?: string;
  status:
    | 'queued'
    | 'running'
    | 'paused'
    | 'waiting_input'
    | 'waiting_child'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  input?: unknown;
  output?: unknown;
  result?: unknown;
  usage?: ChatUsage;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowRunListResponse {
  items: WorkflowRunRecord[];
  total: number;
}

export interface WorkflowRunEventRecord {
  id: number;
  runId: string;
  sequence: number;
  type: string;
  payload?: unknown;
  createdAt: string;
}

export interface SessionAttachment {
  id: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: 'ready' | 'failed';
  createdAt: string;
}

export interface SessionArtifact {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  path: string;
  contentPreview: string;
  createdAt: string;
}

export interface SessionFileChange {
  id: string;
  sessionId: string;
  path: string;
  kind: 'add' | 'update' | 'delete';
  summary: string;
  createdAt: string;
}

export interface SessionOutputsResponse {
  attachments: SessionAttachment[];
  artifacts: SessionArtifact[];
  fileChanges: SessionFileChange[];
}

export interface WakerConnector {
  id: string;
  wakerId: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
  metadata: Record<string, unknown>;
  status: 'disabled' | 'ready' | 'error';
  tools: Array<{ name: string; description?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface WakerPermissionPolicy {
  wakerId: string;
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'untrusted' | 'on-request' | 'on-failure';
  toolGuard: 'deny' | 'ask' | 'allow';
  fileGuard: 'deny' | 'ask' | 'allow';
  builtinTools: string[];
  updatedAt: string;
}

export interface HumanActionRecord {
  id: string;
  wakerId: string;
  source: 'workflow' | 'codex';
  sourceId: string;
  taskId?: string;
  sessionId?: string;
  kind: 'confirm' | 'input';
  title: string;
  prompt: string;
  status: 'pending' | 'handled' | 'ignored';
  result?: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface BoardHumanActionListResponse {
  items: HumanActionRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionContextRecord {
  sessionId: string;
  wakerId: string;
  projectId?: string;
  workingDirectory?: string;
  createdAt: string;
  updatedAt: string;
}

/** Every non-2xx API response uses this shape. */
export interface ApiError {
  error: string;
}
