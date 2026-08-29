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
  memories: number;
  knowledgeBindings: number;
  sharedSkills: number;
  behavior: {
    definition: 'delete';
    sessions: 'delete';
    projects: 'delete-record-only';
    board: 'soft-delete-history';
    connectors: 'delete';
    memories: 'soft-delete';
    knowledgeBindings: 'delete';
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

/**
 * Report of POST /api/v1/agents/import-package; dry-run and apply share the shape
 * (dry-run 只描述计划，apply 报告真实落地结果).
 */
export interface AgentPackageImportReport {
  mode: 'dry-run' | 'apply';
  /** Target agent id (query override wins over the manifest id). */
  agentId: string;
  agentName: string;
  /** create = 新建目标 Agent；overwrite = 覆盖已有定义与包内包含的同类数据。 */
  action: 'create' | 'overwrite';
  /** Unknown/tool-ish frontmatter fields stripped from the imported definition. */
  strippedFrontmatter: string[];
  contents: {
    avatar: boolean;
    memories: number;
    projects: number;
    automations: number;
    workflows: number;
    connectors: number;
    preferences: number;
    knowledgeBindings: number;
  };
  /** Entries that will not / did not land (missing notebook, invalid model preference, bad avatar). */
  skipped: Array<{ kind: string; id: string; reason: string }>;
  /** Per-item write failures (apply only; empty in dry-run). */
  failures: Array<{ kind: string; id: string; error: string }>;
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
  /**
   * 会话级挂载的项目技能名（白名单语义）：设置后该会话只启用列表内的目录技能，
   * 其余目录技能由 runtime 以 `skills.config` path 级 enabled=false 覆盖关掉；
   * 未设置 = 跟随 CLI 默认的全量发现。空数组 = 关闭全部目录技能。
   */
  skills?: string[];
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

/** Payload of POST /api/v1/agents/:agentId/sessions; 全部字段可选。 */
export interface CreateSessionRequest {
  /** 会话级挂载的项目技能名；省略 = 跟随 CLI 默认全量发现。 */
  skills?: string[];
}

/** Payload of PATCH /api/v1/agents/:agentId/sessions/:sessionId; 至少一个字段。 */
export interface UpdateSessionRequest {
  title?: string;
  /** 全量替换挂载列表；null = 取消挂载，恢复 CLI 默认全量发现。 */
  skills?: string[] | null;
}

/** 侧边栏会话分组的一个分组（复刻 QoderWake 0.4.2 console sidebar-sections，最多两级嵌套）。 */
export interface SidebarSection {
  id: string;
  /** 1-32 字符。 */
  name: string;
  /** 父分组 id；顶层为 null。父分组自身不能再有父级。 */
  parentId: string | null;
  /** 同级排序权重。 */
  order: number;
}

/**
 * 一个 Agent 的侧边栏分组全量状态；GET/PUT /api/v1/agents/:agentId/sidebar-sections 的载荷。
 * PUT 为全量替换，updatedAt 由服务端重写。
 */
export interface SidebarSectionsState {
  sections: SidebarSection[];
  /** sessionId → sectionId。 */
  assignments: Record<string, string>;
  /** 顶层条目的展示顺序：section id 与未分组 session id 混合。 */
  entryOrder: string[];
  /** 处于折叠状态的 section id。 */
  collapsed: string[];
  updatedAt: string;
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

/** 一次 turn 失败的本地补记（session_turn_failures 表），runtime-diagnostics 原样携带。 */
export interface SessionTurnFailure {
  timestamp: string;
  errorMessage: string;
  kind?: ChatErrorKind;
  resetAt?: string;
}

/**
 * Payload of GET /api/v1/sessions/:sessionId/runtime-diagnostics（复刻 QoderWake 0.4.2
 * session-runtime diagnostics 的按会话裁剪版）。全部字段来自真实存储：sessions 绑定表、
 * session_turn_failures、Codex rollout JSONL 的解析结果；无数据源的旧版字段直接省略。
 */
export interface SessionRuntimeDiagnostics {
  sessionId: string;
  agentId: string;
  /** 绑定的 Codex thread id；首轮 thread.started 之前为 null。 */
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 由收件箱/attention 状态推导：有未处理的出错/中断 > 已完成 > 空闲。 */
  status: 'idle' | 'needs_attention' | 'completed';
  /** 绑定 thread 的 rollout 文件；未绑定 thread 或文件已删除时为 null。 */
  rollout: { path: string; sizeBytes: number; updatedAt: string } | null;
  /** rollout session_meta 里的运行时信息；无 rollout 时为空对象。 */
  runtime: { cliVersion?: string; modelProvider?: string };
  /** rollout 记录计数，按 `type` 或 `type/payload.type` 分桶。 */
  events: { total: number; byType: Record<string, number> };
  turns: { total: number; completed: number; failed: number; aborted: number; running: number };
  /** rollout 最后一次 token_count 报告的会话级累计用量；从未报告时省略。 */
  usage?: ChatUsage;
  /** 本地补记的 turn 失败（rollout 未留下 error 记录的轮次），按时间升序。 */
  failures: SessionTurnFailure[];
}

export type SessionDebugNodeStatus = 'completed' | 'failed' | 'running' | 'cancelled';
export type SessionDebugSeverity = 'normal' | 'warning' | 'danger';

/**
 * Debug timeline 的一个节点（对齐 QoderWake 0.4.2 buildSessionDebugTimeline 的 node 形状）；
 * kind 取自本地 rollout 可真实提供的事件：turn_start / user_message / reasoning /
 * assistant_message / tool_call / token_usage / error / turn_aborted / turn_complete。
 */
export interface SessionDebugTimelineNode {
  id: string;
  kind: string;
  startedAt: string;
  durationMs: number | null;
  status: SessionDebugNodeStatus;
  severity: SessionDebugSeverity;
  reasonCode?: string;
  supportInfo: Record<string, unknown>;
}

/** Debug timeline 的一轮（对应旧版 round；requestSetId 本地取 rollout turn_id）。 */
export interface SessionDebugTimelineRound {
  id: string;
  index: number;
  requestSetId: string;
  title: 'round_initial' | 'round_followup';
  startedAt: string;
  durationMs: number | null;
  status: SessionDebugNodeStatus;
  nodes: SessionDebugTimelineNode[];
}

/**
 * Payload of GET /api/v1/sessions/:sessionId/debug-timeline（对齐旧版
 * buildSessionDebugTimeline 的整体形状；数据全部来自 rollout 解析）。
 */
export interface SessionDebugTimeline {
  sessionId: string;
  available: boolean;
  generatedAt: string;
  summary: {
    status: SessionDebugNodeStatus | 'insufficient_data';
    totalDurationMs: number | null;
    roundCount: number;
    errorCount: number;
    warningCount: number;
    primaryDelayNodeId?: string;
  };
  rounds: SessionDebugTimelineRound[];
}

/** 一次 turn 的 trace（GET /api/v1/sessions/:sessionId/traces 的条目）。 */
export interface SessionTurnTrace {
  /** rollout 的 turn_id；缺失时退回 `turn-<index>`。 */
  traceId: string;
  index: number;
  status: 'completed' | 'failed' | 'aborted' | 'running';
  /** turn_context 报告的模型；缺失时省略。 */
  model?: string;
  /** turn_context 报告的 reasoning effort；缺失时省略。 */
  thinking?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  /** 本轮 token 用量（token_count 的 last_token_usage）；未报告时省略。 */
  usage?: ChatUsage;
  /** 本轮去重后的工具调用数（function_call 与 item_completed 按 id 合并）。 */
  toolCallCount: number;
  errorMessage?: string;
}

/** Payload of GET /api/v1/sessions/:sessionId/traces。 */
export interface SessionTracesResponse {
  sessionId: string;
  agentId: string;
  items: SessionTurnTrace[];
  total: number;
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

/* ---- Skill 内容版本（`.agents/skills/` 只读取快照，归档于 .codex/skill-versions/） ---- */

export type SkillVersionTrigger = 'manual' | 'auto' | 'rollback';

/** 相对上一版的新增/修改/删除文件（repo 相对 POSIX 路径）。 */
export interface SkillVersionChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

/* ---- Skill 安全扫描（确定性正则/启发式，只报告不拦截） ---- */

export type SkillSafetySeverity = 'critical' | 'warning' | 'info';

export interface SkillSafetyFinding {
  /** 规则 id，如 prompt-injection / secret-exfiltration。 */
  ruleId: string;
  severity: SkillSafetySeverity;
  /** 命中文件（`.agents/skills/` 相对 POSIX 路径）。 */
  path: string;
  /** 1 起始行号。 */
  line: number;
  message: string;
}

export interface SkillScanCounts {
  critical: number;
  warning: number;
  info: number;
}

export interface SkillScanSummary {
  /** 实际参与扫描的文本文件（二进制/超阈值文件不扫）。 */
  scannedPaths: string[];
  /** 命中明细（有上限，截断见 truncated）。 */
  findings: SkillSafetyFinding[];
  counts: SkillScanCounts;
  /** 最高严重级别；零命中为 clean。 */
  level: 'critical' | 'warning' | 'info' | 'clean';
  /** findings 超过保留上限时为 true，counts 仍是完整计数。 */
  truncated?: boolean;
}

/** Payload of POST /api/v1/skills/scan：当前 `.agents/skills/` 全量扫描报告。 */
export interface SkillScanReport extends SkillScanSummary {
  scannedAt: string;
  /** 目录内文件总数（含未参与扫描的）。 */
  totalFiles: number;
}

export interface SkillVersionSummary {
  /** vNNNNNN，零填充序号即时间序。 */
  id: string;
  createdAt: string;
  label?: string;
  trigger: SkillVersionTrigger;
  /** 整树指纹：按路径排序的 路径+逐文件 sha256 的 sha256。 */
  fingerprint: string;
  fileCount: number;
  changes: SkillVersionChanges;
  /** 记版时对 added/modified 文本文件的安全扫描摘要；老版本快照可能缺失。 */
  scan?: SkillScanSummary;
}

export interface SkillVersionFileEntry {
  path: string;
  sha256: string;
  size: number;
  /** false = 超过 1MB 只记指纹未归档内容，diff/rollback 无法还原该文件。 */
  archived: boolean;
}

/** Payload of GET /api/v1/skills/versions/:versionId。 */
export interface SkillVersionDetail extends SkillVersionSummary {
  files: SkillVersionFileEntry[];
}

/** Payload of GET /api/v1/skills/versions。 */
export interface SkillVersionListResponse {
  items: SkillVersionSummary[];
  total: number;
}

/** Payload of POST /api/v1/skills/snapshots。 */
export interface SkillSnapshotRequest {
  label?: string;
}

export interface SkillSnapshotResponse {
  version: SkillVersionDetail;
  /** false = 目录无漂移，返回的是最新既有版本。 */
  created: boolean;
}

export interface SkillDiffFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** 文本文件且有归档内容时的 unified diff。 */
  diff?: string;
  /** 二进制或未归档内容时的说明（替代 diff）。 */
  note?: string;
}

/** Payload of GET /api/v1/skills/diff?from=&to=；to 可为字面量 current（实时目录）。 */
export interface SkillDiffResponse {
  from: string;
  to: string;
  files: SkillDiffFileChange[];
}

/** Payload of POST /api/v1/skills/rollback；默认 dry-run，apply=true 才写入。 */
export interface SkillRollbackRequest {
  versionId: string;
  apply?: boolean;
  reason?: string;
}

export interface SkillRollbackPlan {
  /** 内容将被恢复为快照内容的文件。 */
  restore: string[];
  /** 快照之后新增、将被删除的文件。 */
  delete: string[];
  unchanged: number;
  skipped: { path: string; reason: string }[];
  upToDate: boolean;
}

export interface SkillRollbackResponse {
  versionId: string;
  applied: boolean;
  plan: SkillRollbackPlan;
  /** apply=true 写入前自动打的当前状态快照 id（可借此反悔）。 */
  preSnapshotId?: string;
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

/** Payload for POST /api/v1/agents/:agentId/summarize-profile; derives the 关于我 profile with a one-shot model call. */
export interface SummarizeAgentProfileRequest {
  /** Optional model override; must be in the configured catalog (invalid values are 400). */
  model?: string;
  /** Optional per-call thinking level. */
  thinking?: AgentThinkingLevel;
  /** When true, the derived sections are written back into the agent file frontmatter. */
  apply?: boolean;
}

/** Model-derived agent profile; mirrors the legacy coreCapabilities/workStyles shape. */
export interface AgentDerivedProfile {
  /** Derived 我最擅长 items (legacy coreCapabilities: 4-5 {name, description} entries). */
  coreCapabilities: AgentProfileSectionItem[];
  /** Derived 工作风格 items (legacy workStyles: 4-5 {name, description} entries). */
  workStyles: AgentProfileSectionItem[];
  /** Derived task descriptions the agent is a good fit for; returned but never persisted. */
  suggestedUseCases: string[];
}

/** Payload of POST /api/v1/agents/:agentId/summarize-profile. */
export interface SummarizeAgentProfileResponse {
  agentId: string;
  profile: AgentDerivedProfile;
  /** True when apply wrote the derived sections back into .codex/agents/<id>.md. */
  applied: boolean;
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
  kind: 'schedule' | 'api' | 'event' | 'git-poll';
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
  /** Inbound api/event trigger credential; present only for externally triggered kinds. */
  triggerKey?: string;
  /** git-poll：轮询的 git 仓库（本地路径或远端 URL）。 */
  repo?: string;
  /** git-poll：轮询的分支；缺省表示仓库默认分支/HEAD。 */
  branch?: string;
  /** git-poll：轮询间隔（秒）。 */
  pollIntervalSeconds?: number;
  /** git-poll：上次观测到的分支头 commit。 */
  lastSeenCommit?: string;
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

export type MemoryMaintenanceTrigger = 'cron' | 'manual';

export interface MemoryMaintenanceAction {
  documentId: string;
  title: string;
  action: 'deleted' | 'skipped';
  reason: string;
  snapshotId?: string;
}

export interface MemoryMaintenanceReport {
  scope: MemoryScope;
  trigger: MemoryMaintenanceTrigger;
  startedAt: string;
  finishedAt: string;
  checked: number;
  deleted: number;
  snapshotted: number;
  skipped: number;
  actions: MemoryMaintenanceAction[];
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  taskId: string;
  wakerId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  trigger: 'manual' | 'scheduled' | 'api' | 'event' | 'git';
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

export type AutomationRunStatusName =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';
export type AutomationRunTriggerName = 'manual' | 'scheduled' | 'api' | 'event' | 'git';

export interface AutomationRunStatsBreakdown {
  total: number;
  byStatus: Record<AutomationRunStatusName, number>;
  byTrigger: Record<AutomationRunTriggerName, number>;
  /** succeeded / (succeeded + failed + cancelled); null until a run reaches a finished status. */
  successRate: number | null;
  lastRunAt?: string;
  lastRunStatus?: AutomationRunStatusName;
}

export interface AutomationStatsEntry extends AutomationRunStatsBreakdown {
  automationId: string;
  name: string;
  kind: 'schedule' | 'api' | 'event' | 'git-poll';
  enabled: boolean;
}

export interface AutomationStatsResponse {
  wakerId: string;
  totals: AutomationRunStatsBreakdown;
  automations: AutomationStatsEntry[];
}

export interface AutomationCalendarDay {
  /** YYYY-MM-DD in the requested timezone. */
  date: string;
  /** Runs created on that day. */
  runs: number;
  /** Planned occurrences of enabled schedule automations on that day. */
  scheduled: number;
}

export interface AutomationCalendarResponse {
  wakerId: string;
  timezone: string;
  from: string;
  to: string;
  days: AutomationCalendarDay[];
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
  /** 最近一次 enable/probe 失败的错误消息（status 为 error 时给出）。 */
  error?: string;
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
