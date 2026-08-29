import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AGENT_ID_PATTERN,
  type ChatCitationSource,
  type ChatErrorKind,
  type SessionDebugTimeline,
  type SessionMessage,
  type SessionRuntimeDiagnostics,
  type SessionSummary,
  type SessionTracesResponse,
  type SessionTurnFailure,
  type SidebarSectionsState,
} from '@waker/contracts';
import {
  analyzeRollout,
  buildSessionDebugTimeline,
  tracesFromAnalysis,
  type RolloutAnalysis,
} from './diagnostics.js';
import { readCodexSettings } from './model-config.js';
import { parseRolloutMessages, sanitizeCitationSources } from './rollout.js';
import {
  emptySidebarSections,
  SidebarSectionsValidationError,
  validateSidebarSections,
} from './sidebar-sections.js';

const AGENT_ID_REGEX = new RegExp(AGENT_ID_PATTERN);

/** Session/binding contract violations; `code` doubles as the message so existing callers keep working. */
export type SessionBindingErrorCode =
  | 'AGENT_BINDING_CONFLICT'
  | 'AGENT_BINDING_MISSING'
  | 'AGENT_BINDING_INVALID'
  | 'AGENT_SESSION_MISMATCH'
  | 'AGENT_SESSION_NOT_FOUND';

export class SessionBindingError extends Error {
  readonly code: SessionBindingErrorCode;
  constructor(code: SessionBindingErrorCode) {
    super(code);
    this.name = 'SessionBindingError';
    this.code = code;
  }
}

/** One row of the sessions table: the immutable agent binding plus UI state. */
export interface WorkbenchSessionEntry {
  agentId: string;
  /** Codex thread id once the first turn reported thread.started; null before that. */
  threadId: string | null;
  title?: string;
  createdAt: string;
  updatedAt: string;
  /** 收件箱已读 = 用户已查看且此后没有新的出错/中断。 */
  read?: boolean;
  /** 被标记完成的时间；未完成为 undefined。 */
  completedAt?: string;
  /** 会话级挂载的项目技能名（白名单）；undefined = 跟随 CLI 默认全量发现。 */
  skills?: string[];
}

/** 旧版 .codex/workbench.json 的形状，仅用于一次性迁移。 */
interface WorkbenchFileData {
  sessions: Record<string, WorkbenchSessionEntry>;
  preferences: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  agent_id: string;
  thread_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  read: number | null;
  completed_at: string | null;
  skills: string | null;
}

function skillsFromJson(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const names = parsed.filter((name): name is string => typeof name === 'string');
    return names;
  } catch {
    return undefined; // 单行坏 JSON 按未挂载处理，不影响会话本身。
  }
}

function entryFromRow(row: SessionRow): WorkbenchSessionEntry {
  const skills = skillsFromJson(row.skills);
  return {
    agentId: row.agent_id,
    threadId: row.thread_id,
    ...(row.title !== null ? { title: row.title } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    read: row.read === 1,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(skills !== undefined ? { skills } : {}),
  };
}

function rowParams(id: string, entry: WorkbenchSessionEntry): unknown[] {
  return [
    id,
    entry.agentId,
    entry.threadId ?? null,
    entry.title ?? null,
    entry.createdAt,
    entry.updatedAt,
    entry.read ? 1 : 0,
    entry.completedAt ?? null,
    entry.skills !== undefined ? JSON.stringify(entry.skills) : null,
  ];
}

/** 一次 turn 失败的本地补记：rollout 没有 error 记录时（如 provider 直接拒流）由 API 写入。 */
export interface TurnFailureRecord {
  timestamp: string;
  errorMessage: string;
  kind?: ChatErrorKind;
  resetAt?: string;
}

interface TurnFailureRow {
  id: number;
  created_at: string;
  error_message: string;
  kind: string | null;
  reset_at: string | null;
}

const CHAT_ERROR_KINDS: ReadonlySet<string> = new Set([
  'quota',
  'rate_limit',
  'auth',
  'timeout',
  'network',
  'startup',
  'generic',
]);

function failureFromRow(row: TurnFailureRow): TurnFailureRecord & { id: number } {
  return {
    id: row.id,
    timestamp: row.created_at,
    errorMessage: row.error_message,
    ...(row.kind && CHAT_ERROR_KINDS.has(row.kind) ? { kind: row.kind as ChatErrorKind } : {}),
    ...(row.reset_at ? { resetAt: row.reset_at } : {}),
  };
}

/**
 * SQLite projection (better-sqlite3) for everything the Codex CLI does NOT own:
 * session ↔ agent bindings, inbox read/completed state, UI preferences. The CLI
 * owns the rollout JSONL files; this store never writes into them.
 * 数据库落在 .codex/workbench.sqlite（同步 API，单进程本地场景无需连接池）。
 * 首次打开时若存在旧的 .codex/workbench.json 且 sessions/preferences 均为空，事务导入后把旧文件
 * 改名为 workbench.json.bak；旧文件损坏则跳过迁移，保持此前的容错语义。
 */
export class WorkbenchStore {
  readonly cwd: string;
  readonly file: string;
  private readonly db: Database.Database;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.file = join(this.cwd, '.codex', 'workbench.sqlite');
    mkdirSync(join(this.cwd, '.codex'), { recursive: true });
    this.db = new Database(this.file);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        thread_id TEXT,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        read INTEGER,
        completed_at TEXT,
        skills TEXT
      );
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sidebar_sections (
        agent_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_turn_sources (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL CHECK(turn_index >= 1),
        sources_json TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_index)
      );
      CREATE TABLE IF NOT EXISTS session_turn_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        error_message TEXT NOT NULL,
        kind TEXT,
        reset_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_turn_failures_session
        ON session_turn_failures(session_id);
    `);
    this.migrateSessionSkillsColumn();
    this.migrateLegacyJson();
  }

  /** 既有库补 skills 列（会话级技能挂载）；CREATE TABLE 只覆盖新库。 */
  private migrateSessionSkillsColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'skills')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN skills TEXT');
    }
  }

  /** 从旧 workbench.json 一次性迁移；仅在数据库为空且旧文件可读时发生。 */
  private migrateLegacyJson(): void {
    const legacy = join(this.cwd, '.codex', 'workbench.json');
    if (!existsSync(legacy)) return;
    const { n } = this.db
      .prepare('SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM preferences) AS n')
      .get() as { n: number };
    if (n > 0) return;
    let parsed: Partial<WorkbenchFileData>;
    try {
      parsed = JSON.parse(readFileSync(legacy, 'utf8')) as Partial<WorkbenchFileData>;
    } catch {
      return;
    }
    const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    const preferences =
      parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {};
    const insertSession = this.db.prepare(
      `INSERT INTO sessions (id, agent_id, thread_id, title, created_at, updated_at, read, completed_at, skills)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_id=excluded.agent_id,
         thread_id=excluded.thread_id,
         title=excluded.title,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at,
         read=excluded.read,
         completed_at=excluded.completed_at,
         skills=excluded.skills`,
    );
    const insertPreference = this.db.prepare(
      'INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)',
    );
    this.db.transaction(() => {
      for (const [id, entry] of Object.entries(sessions)) {
        insertSession.run(...rowParams(id, entry));
      }
      for (const [key, value] of Object.entries(preferences)) {
        insertPreference.run(key, JSON.stringify(value));
      }
    })();
    renameSync(legacy, `${legacy}.bak`);
  }

  listEntries(): Record<string, WorkbenchSessionEntry> {
    const rows = this.db.prepare('SELECT * FROM sessions').all() as SessionRow[];
    return Object.fromEntries(rows.map((row) => [row.id, entryFromRow(row)]));
  }

  getEntry(id: string): WorkbenchSessionEntry | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? entryFromRow(row) : undefined;
  }

  putEntry(id: string, entry: WorkbenchSessionEntry): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, thread_id, title, created_at, updated_at, read, completed_at, skills)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_id=excluded.agent_id,
           thread_id=excluded.thread_id,
           title=excluded.title,
           created_at=excluded.created_at,
           updated_at=excluded.updated_at,
           read=excluded.read,
           completed_at=excluded.completed_at,
           skills=excluded.skills`,
      )
      .run(...rowParams(id, entry));
  }

  patchEntry(id: string, patch: Partial<WorkbenchSessionEntry>): WorkbenchSessionEntry | undefined {
    const current = this.getEntry(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.putEntry(id, next);
    return next;
  }

  deleteEntry(id: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }

  setTurnSources(sessionId: string, turnIndex: number, sources: ChatCitationSource[]): void {
    if (!Number.isSafeInteger(turnIndex) || turnIndex < 1) throw new Error('Invalid turn index');
    if (!sources.length) {
      this.db
        .prepare('DELETE FROM session_turn_sources WHERE session_id = ? AND turn_index = ?')
        .run(sessionId, turnIndex);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO session_turn_sources(session_id, turn_index, sources_json) VALUES (?, ?, ?)
         ON CONFLICT(session_id, turn_index) DO UPDATE SET sources_json=excluded.sources_json`,
      )
      .run(sessionId, turnIndex, JSON.stringify(sources));
  }

  listTurnSources(sessionId: string): Map<number, ChatCitationSource[]> {
    const rows = this.db
      .prepare(
        'SELECT turn_index, sources_json FROM session_turn_sources WHERE session_id = ? ORDER BY turn_index',
      )
      .all(sessionId) as Array<{ turn_index: number; sources_json: string }>;
    const sources = new Map<number, ChatCitationSource[]>();
    for (const row of rows) {
      try {
        const clean = sanitizeCitationSources(JSON.parse(row.sources_json) as unknown);
        if (clean.length) sources.set(row.turn_index, clean);
      } catch {
        // A corrupt sidecar row cannot make session history unavailable.
      }
    }
    return sources;
  }

  /** 补记一次 turn 失败（rollout 未留下 error 记录的失败轮次）；时间戳由调用方给出。 */
  recordTurnFailure(sessionId: string, failure: TurnFailureRecord): void {
    this.db
      .prepare(
        `INSERT INTO session_turn_failures (session_id, created_at, error_message, kind, reset_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        failure.timestamp,
        failure.errorMessage,
        failure.kind ?? null,
        failure.resetAt ?? null,
      );
  }

  /** 按时间升序列出一个会话的全部失败补记。 */
  listTurnFailures(sessionId: string): Array<TurnFailureRecord & { id: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, error_message, kind, reset_at
         FROM session_turn_failures WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(sessionId) as TurnFailureRow[];
    return rows.map(failureFromRow);
  }

  /**
   * 活跃度热力图数据：按 updated_at 的日期分组统计一个 Agent 的会话数。
   * date() 直接解析 ISO 时间戳（UTC），只读单 Agent 的行，按日期升序返回。
   */
  sessionActivityByDay(agentId: string): Array<{ date: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT date(updated_at) AS day, COUNT(*) AS n
         FROM sessions WHERE agent_id = ?
         GROUP BY day ORDER BY day`,
      )
      .all(agentId) as Array<{ day: string; n: number }>;
    return rows.map((row) => ({ date: row.day, count: row.n }));
  }

  getPreferences(): Record<string, unknown> {    const rows = this.db.prepare('SELECT key, value FROM preferences').all() as Array<{
      key: string;
      value: string;
    }>;
    const preferences: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        preferences[row.key] = JSON.parse(row.value) as unknown;
      } catch {
        // 单行坏 JSON 跳过即可，不应拖垮整个 preferences 读取。
      }
    }
    return preferences;
  }

  setPreference(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  deletePreference(key: string): void {
    this.db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
  }

  /** 读一个 Agent 的侧边栏分组全量状态；无记录或内容损坏返回 undefined。 */
  getSidebarSections(agentId: string): SidebarSectionsState | undefined {
    const row = this.db
      .prepare('SELECT state_json FROM sidebar_sections WHERE agent_id = ?')
      .get(agentId) as { state_json: string } | undefined;
    if (!row) return undefined;
    try {
      return validateSidebarSections(JSON.parse(row.state_json));
    } catch {
      return undefined;
    }
  }

  putSidebarSections(agentId: string, state: SidebarSectionsState): void {
    this.db
      .prepare(
        `INSERT INTO sidebar_sections (agent_id, state_json) VALUES (?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET state_json=excluded.state_json`,
      )
      .run(agentId, JSON.stringify(state));
  }

  deleteSidebarSections(agentId: string): void {
    this.db.prepare('DELETE FROM sidebar_sections WHERE agent_id = ?').run(agentId);
  }

  /**
   * 关闭底层 sqlite 连接。共享缓存实例（workbenchStoreFor）的生命周期跟随进程，
   * 只有直接 new 出来的实例（如测试）需要调用。
   */
  close(): void {
    this.db.close();
  }
}

/** One WorkbenchStore per project root; the file itself stays the source of truth. */
const workbenchStores = new Map<string, WorkbenchStore>();

/**
 * 按项目根目录共享 WorkbenchStore：每 new 一次 WorkbenchStore 就多开一条 sqlite
 * 连接，逐会话创建会让连接数随会话数无界增长。共享实例不随 registry 淘汰关闭。
 */
export function workbenchStoreFor(cwd: string): WorkbenchStore {
  const root = resolve(cwd);
  let store = workbenchStores.get(root);
  if (!store) {
    store = new WorkbenchStore(root);
    workbenchStores.set(root, store);
  }
  return store;
}

/**
 * Every persisted Web session carries exactly one immutable agent binding in the
 * workbench sessions table. Sessions without a binding are invalid and are never
 * migrated or inferred; a mismatched binding is rejected.
 */
export function assertSessionAgentBinding(
  entry: WorkbenchSessionEntry | undefined,
  expectedAgentId?: string,
): string {
  if (!entry) throw new SessionBindingError('AGENT_BINDING_MISSING');
  if (typeof entry.agentId !== 'string' || !AGENT_ID_REGEX.test(entry.agentId))
    throw new SessionBindingError('AGENT_BINDING_INVALID');
  if (expectedAgentId && entry.agentId !== expectedAgentId)
    throw new SessionBindingError('AGENT_SESSION_MISMATCH');
  return entry.agentId;
}

export function getCodexSessionDir(cwd: string): string {
  const configured = process.env.CODEX_SESSION_DIR?.trim();
  if (configured) return resolve(cwd, configured);
  const settings = readCodexSettings(cwd) as { sessionDir?: unknown };
  if (typeof settings.sessionDir === 'string' && settings.sessionDir.trim())
    return resolve(cwd, settings.sessionDir.trim());
  return resolve(cwd, '.codex/sessions');
}

/** SessionSummary plus the inbox read/completed state stored on the workbench entry. */
export interface SessionRecord extends SessionSummary {
  read: boolean;
  completedAt?: string;
}

export interface AgentSessionStoreOptions {
  cwd: string;
  sessionDir?: string;
}

type SessionAttention = Pick<
  SessionSummary,
  'needsAttention' | 'attentionReason' | 'attentionDetail'
>;

/**
 * Attention is derived from the last assistant message parsed from the rollout:
 * a turn that failed or was interrupted carries stopReason "error" / "aborted".
 * A later successful run clears the flag.
 */
function attentionFromMessages(messages: SessionMessage[]): SessionAttention {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return {
        needsAttention: true,
        attentionReason: message.stopReason,
        ...(message.errorMessage ? { attentionDetail: message.errorMessage } : {}),
      };
    }
    return { needsAttention: false };
  }
  return { needsAttention: false };
}

function lastText(messages: SessionMessage[], role: 'user' | 'assistant'): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === role && message.content) return message.content;
  }
  return '';
}

/** 收件箱预览：最后一条 assistant 文本，为空退回最后一条 user 文本；压缩成单行截 120 字符。 */
function previewFromMessages(messages: SessionMessage[]): string | undefined {
  const collapsed = (lastText(messages, 'assistant') || lastText(messages, 'user'))
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed ? collapsed.slice(0, 120) : undefined;
}

/**
 * Web session projection. The workbench database (better-sqlite3) holds the
 * binding and UI state; message content is replayed on demand from the CLI-owned
 * rollout JSONL located by the bound threadId. This store never appends entries
 * to the rollout files themselves.
 */
export class AgentSessionStore {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly workbench: WorkbenchStore;
  /**
   * rollout 解析结果按 path+mtimeMs 缓存：listSessions 不再为每个会话文件重复
   * 读盘+解析。进行中的会话会让文件 mtime 变化，天然触发重解析；无 watch 需求。
   */
  private readonly rolloutCache = new Map<
    string,
    { mtimeMs: number; messages: SessionMessage[] }
  >();
  /** threadId → rollout 文件路径；文件消失时作废重扫。 */
  private readonly threadFileCache = new Map<string, string>();

  constructor(options: AgentSessionStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionDir = resolve(this.cwd, options.sessionDir ?? getCodexSessionDir(this.cwd));
    // 同一项目根共享一条 sqlite 连接（workbenchStoreFor 按 cwd 缓存）。
    this.workbench = workbenchStoreFor(this.cwd);
  }

  /** 透传 WorkbenchStore.close()；共享实例随进程生命周期，一般只在测试里调用。 */
  close(): void {
    this.workbench.close();
  }

  async listSessions(agentId?: string): Promise<SessionRecord[]> {
    const entries = Object.entries(this.workbench.listEntries()).sort(
      (left, right) =>
        left[1].createdAt.localeCompare(right[1].createdAt) || left[0].localeCompare(right[0]),
    );
    // 清掉已删除会话的缓存条目，避免 map 随删除操作无限增长。
    const liveThreadIds = new Set(
      entries
        .map(([, entry]) => entry.threadId)
        .filter((id): id is string => typeof id === 'string'),
    );
    for (const [threadId, path] of this.threadFileCache) {
      if (!liveThreadIds.has(threadId)) {
        this.threadFileCache.delete(threadId);
        this.rolloutCache.delete(path);
      }
    }
    const records = entries.map(([id, entry]) => {
      try {
        assertSessionAgentBinding(entry);
      } catch {
        return undefined; // 绑定缺失/非法的会话不迁移、不展示。
      }
      return this.recordFromEntry(id, entry);
    });
    const defined = records.filter((record): record is SessionRecord => Boolean(record));
    return agentId ? defined.filter((record) => record.agentId === agentId) : defined;
  }

  async createSession(
    agentId: string,
    id = `session_${randomUUID().slice(0, 8)}`,
  ): Promise<SessionRecord> {
    if (!AGENT_ID_REGEX.test(agentId)) throw new SessionBindingError('AGENT_BINDING_INVALID');
    const existing = this.workbench.getEntry(id);
    if (existing) {
      assertSessionAgentBinding(existing, agentId);
      return this.recordFromEntry(id, existing);
    }
    const now = new Date().toISOString();
    const entry: WorkbenchSessionEntry = {
      agentId,
      threadId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.workbench.putEntry(id, entry);
    return this.recordFromEntry(id, entry);
  }

  /** Creates the session when absent; rejects reuse through another agent. */
  async ensureSession(id: string, agentId: string): Promise<SessionRecord> {
    const existing = await this.getSession(id);
    if (existing && existing.agentId !== agentId)
      throw new SessionBindingError('AGENT_SESSION_MISMATCH');
    return existing ?? this.createSession(agentId, id);
  }

  async getSession(id: string, expectedAgentId?: string): Promise<SessionRecord | undefined> {
    const entry = this.workbench.getEntry(id);
    if (!entry) return undefined;
    try {
      assertSessionAgentBinding(entry);
    } catch {
      return undefined; // 绑定缺失/非法的会话按不存在处理，不抛给列表调用方。
    }
    if (expectedAgentId && entry.agentId !== expectedAgentId)
      throw new SessionBindingError('AGENT_SESSION_MISMATCH');
    return this.recordFromEntry(id, entry);
  }

  /** Raw binding entry for the runtime (threadId resume); binding rules still apply. */
  getEntry(id: string, expectedAgentId?: string): WorkbenchSessionEntry | undefined {
    const entry = this.workbench.getEntry(id);
    if (!entry) return undefined;
    assertSessionAgentBinding(entry, expectedAgentId);
    return entry;
  }

  /** Persists the thread id reported by thread.started onto the session binding. */
  async bindThread(id: string, agentId: string, threadId: string): Promise<SessionRecord> {
    const entry = this.requireEntry(id, agentId);
    if (entry.threadId === threadId) return this.recordFromEntry(id, entry);
    const next = this.workbench.patchEntry(id, { threadId, updatedAt: new Date().toISOString() })!;
    return this.recordFromEntry(id, next);
  }

  async renameSession(
    id: string,
    agentId: string,
    title: string,
  ): Promise<SessionRecord | undefined> {
    this.requireEntry(id, agentId);
    const next = this.workbench.patchEntry(id, {
      title: title.trim(),
      updatedAt: new Date().toISOString(),
    });
    return next ? this.recordFromEntry(id, next) : undefined;
  }

  /**
   * 全量替换会话级挂载的技能名（白名单）；undefined = 取消挂载恢复 CLI 默认发现。
   * 技能名合法性由调用方（API 层对照技能目录）校验，这里只负责持久化。
   */
  async setSessionSkills(
    id: string,
    agentId: string,
    skills: string[] | undefined,
  ): Promise<SessionRecord | undefined> {
    this.requireEntry(id, agentId);
    const next = this.workbench.patchEntry(id, {
      skills,
      updatedAt: new Date().toISOString(),
    });
    return next ? this.recordFromEntry(id, next) : undefined;
  }

  /** 收件箱已读/完成状态直接落在 sessions 表的会话行上。 */
  async updateInboxState(
    id: string,
    agentId: string,
    patch: { read?: boolean; completed?: boolean },
  ): Promise<SessionRecord | undefined> {
    this.requireEntry(id, agentId);
    const update: Partial<WorkbenchSessionEntry> = {};
    if (patch.read !== undefined) update.read = patch.read;
    if (patch.completed !== undefined)
      update.completedAt = patch.completed ? new Date().toISOString() : undefined;
    const next = this.workbench.patchEntry(id, update);
    return next ? this.recordFromEntry(id, next) : undefined;
  }

  /** Replays the persisted messages of one session; the rollout JSONL stays the source of truth. */
  async listMessages(id: string, agentId: string): Promise<SessionMessage[]> {
    const entry = this.requireEntry(id, agentId);
    const messages = entry.threadId ? this.messagesForThread(entry.threadId) : [];
    return this.withTurnFailures(id, this.withTurnSources(id, messages));
  }

  /** 补记一次 turn 失败（API 在 turn 抛错时调用）；中断走 rollout 的 turn_aborted，不经过这里。 */
  recordTurnFailure(id: string, agentId: string, failure: TurnFailureRecord): void {
    this.requireEntry(id, agentId);
    this.workbench.recordTurnFailure(id, failure);
  }

  /**
   * Session runtime 诊断（复刻 QoderWake 0.4.2 session-runtime diagnostics 的按会话版）。
   * 绑定缺失/非法按不存在处理返回 undefined；所有字段来自 sessions 表、
   * session_turn_failures 与 rollout 解析，不做任何推断填充。
   */
  async getRuntimeDiagnostics(id: string): Promise<SessionRuntimeDiagnostics | undefined> {
    const entry = this.workbench.getEntry(id);
    if (!entry) return undefined;
    try {
      assertSessionAgentBinding(entry);
    } catch {
      return undefined;
    }
    const record = this.recordFromEntry(id, entry);
    const rollout = entry.threadId ? this.readRollout(entry.threadId) : undefined;
    const analysis = rollout ? analyzeRollout(rollout.content, [this.cwd]) : undefined;
    const turns = { total: 0, completed: 0, failed: 0, aborted: 0, running: 0 };
    for (const turn of analysis?.turns ?? []) {
      turns.total += 1;
      turns[turn.status === 'aborted' ? 'aborted' : turn.status] += 1;
    }
    const failures: SessionTurnFailure[] = this.workbench.listTurnFailures(id).map((row) => {
      const { id: _rowId, ...failure } = row;
      return failure;
    });
    return {
      sessionId: id,
      agentId: entry.agentId,
      threadId: entry.threadId,
      createdAt: entry.createdAt,
      updatedAt: record.updatedAt,
      status: record.needsAttention ? 'needs_attention' : record.completedAt ? 'completed' : 'idle',
      rollout: rollout
        ? { path: rollout.path, sizeBytes: rollout.sizeBytes, updatedAt: rollout.updatedAt }
        : null,
      runtime: {
        ...(analysis?.meta.cliVersion ? { cliVersion: analysis.meta.cliVersion } : {}),
        ...(analysis?.meta.modelProvider ? { modelProvider: analysis.meta.modelProvider } : {}),
      },
      events: {
        total: analysis?.totalEvents ?? 0,
        byType: analysis?.eventsByType ?? {},
      },
      turns,
      ...(analysis?.cumulativeUsage ? { usage: analysis.cumulativeUsage } : {}),
      failures,
    };
  }

  /**
   * Debug timeline（对齐旧版 buildSessionDebugTimeline 形状）：rollout 事件按 turn
   * 归组为 rounds/nodes。limit 取最近 N 轮；无 rollout 时 available=false。
   */
  async getDebugTimeline(id: string, limit?: number): Promise<SessionDebugTimeline | undefined> {
    const analysis = this.analyzeSessionRollout(id);
    if (analysis === undefined) return undefined;
    return buildSessionDebugTimeline({
      sessionId: id,
      analysis,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  /** 每次 turn 的 trace（模型/thinking/token 用量/耗时/工具调用计数），limit 取最近 N 条。 */
  async getSessionTraces(id: string, limit?: number): Promise<SessionTracesResponse | undefined> {
    const analysis = this.analyzeSessionRollout(id);
    if (analysis === undefined) return undefined;
    const all = tracesFromAnalysis(analysis);
    const items =
      limit !== undefined && all.length > limit ? all.slice(all.length - limit) : all;
    const entry = this.workbench.getEntry(id)!;
    return { sessionId: id, agentId: entry.agentId, items, total: items.length };
  }

  /** 会话存在性校验 + rollout 解析的公共路径；会话不存在/绑定非法返回 undefined。 */
  private analyzeSessionRollout(id: string): RolloutAnalysis | undefined {
    const entry = this.workbench.getEntry(id);
    if (!entry) return undefined;
    try {
      assertSessionAgentBinding(entry);
    } catch {
      return undefined;
    }
    const rollout = entry.threadId ? this.readRollout(entry.threadId) : undefined;
    return rollout
      ? analyzeRollout(rollout.content, [this.cwd])
      : analyzeRollout('', [this.cwd]);
  }

  /** Stores host-owned provenance for one serialized user turn; browser text never owns it. */
  setTurnSources(
    id: string,
    agentId: string,
    turnIndex: number,
    sources: ChatCitationSource[],
  ): void {
    this.requireEntry(id, agentId);
    this.workbench.setTurnSources(id, turnIndex, sanitizeCitationSources(sources));
  }

  async deleteSession(id: string, agentId: string): Promise<boolean> {
    const entry = this.workbench.getEntry(id);
    if (!entry) return false;
    assertSessionAgentBinding(entry, agentId);
    if (entry.threadId) {
      const file = this.findRolloutFile(entry.threadId);
      if (file) {
        rmSync(file, { force: true });
        this.rolloutCache.delete(file);
        this.threadFileCache.delete(entry.threadId);
      }
    }
    this.workbench.deleteEntry(id);
    this.pruneSidebarSections(agentId, id);
    return true;
  }

  /** 侧边栏会话分组：无记录时返回空默认（对齐旧版 emptySidebarSections）。 */
  async getSidebarSections(agentId: string): Promise<SidebarSectionsState> {
    return this.workbench.getSidebarSections(agentId) ?? emptySidebarSections();
  }

  /**
   * 全量替换侧边栏分组。结构校验之外复核引用的 sessionId 必须属于该 Agent
   * （assignments 的 key，以及 entryOrder 里非 section id 的条目），updatedAt 由服务端重写。
   */
  async putSidebarSections(agentId: string, value: unknown): Promise<SidebarSectionsState> {
    if (!AGENT_ID_REGEX.test(agentId)) throw new SessionBindingError('AGENT_BINDING_INVALID');
    const state = validateSidebarSections(value);
    state.updatedAt = new Date().toISOString();
    const sectionIds = new Set(state.sections.map((section) => section.id));
    const referenced = new Set<string>([
      ...Object.keys(state.assignments),
      ...state.entryOrder.filter((key) => !sectionIds.has(key)),
    ]);
    if (referenced.size) {
      const entries = this.workbench.listEntries();
      for (const sessionId of referenced) {
        const entry = entries[sessionId];
        if (!entry || entry.agentId !== agentId) {
          throw new SidebarSectionsValidationError(`unknown session for agent: ${sessionId}`);
        }
      }
    }
    this.workbench.putSidebarSections(agentId, state);
    return state;
  }

  /** Agent 删除时清掉它的分组状态（表按 agent_id 主键隔离，不会随 sessions 行级联）。 */
  deleteSidebarSections(agentId: string): void {
    this.workbench.deleteSidebarSections(agentId);
  }

  /** 会话删除后同步清掉分组里的悬空引用，避免 GET 回读到已删除的 sessionId。 */
  private pruneSidebarSections(agentId: string, sessionId: string): void {
    const state = this.workbench.getSidebarSections(agentId);
    if (!state) return;
    if (!(sessionId in state.assignments) && !state.entryOrder.includes(sessionId)) return;
    const assignments = { ...state.assignments };
    delete assignments[sessionId];
    this.workbench.putSidebarSections(agentId, {
      ...state,
      assignments,
      entryOrder: state.entryOrder.filter((key) => key !== sessionId),
    });
  }

  private requireEntry(id: string, agentId: string): WorkbenchSessionEntry {
    const entry = this.workbench.getEntry(id);
    if (!entry) throw new SessionBindingError('AGENT_SESSION_NOT_FOUND');
    assertSessionAgentBinding(entry, agentId);
    return entry;
  }

  /** Recursively scans sessionDir for the rollout file of one thread (rollout-<ts>-<threadId>.jsonl). */
  private findRolloutFile(threadId: string): string | undefined {
    const cached = this.threadFileCache.get(threadId);
    if (cached && existsSync(cached)) return cached;
    let found: string | undefined;
    const visit = (directory: string): void => {
      if (found) return;
      let children;
      try {
        children = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        if (found) return;
        const path = join(directory, child.name);
        if (child.isDirectory()) visit(path);
        else if (
          child.isFile() &&
          child.name.startsWith('rollout-') &&
          child.name.endsWith('.jsonl') &&
          child.name.includes(threadId)
        ) {
          // 重名取最新：同一 thread 理论上只有一个 rollout，防御性处理。
          if (!found || statSync(path).mtimeMs > statSync(found).mtimeMs) found = path;
        }
      }
    };
    visit(this.sessionDir);
    if (found) this.threadFileCache.set(threadId, found);
    else this.threadFileCache.delete(threadId);
    return found;
  }

  /** 读取绑定 thread 的 rollout 原文与文件状态；诊断端点低频调用，不走 mtime 缓存。 */
  private readRollout(
    threadId: string,
  ): { path: string; content: string; sizeBytes: number; updatedAt: string } | undefined {
    const file = this.findRolloutFile(threadId);
    if (!file) return undefined;
    try {
      const stat = statSync(file);
      return {
        path: file,
        content: readFileSync(file, 'utf8'),
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  /** Parses one rollout JSONL once per file version; mtime changes force a re-parse. */
  private messagesForThread(threadId: string): SessionMessage[] {
    const file = this.findRolloutFile(threadId);
    if (!file) return [];
    const mtimeMs = statSync(file).mtimeMs;
    const cached = this.rolloutCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.messages;
    const messages = parseRolloutMessages(readFileSync(file, 'utf8'), [this.cwd]);
    this.rolloutCache.set(file, { mtimeMs, messages });
    return messages;
  }

  /** Overlays each turn's provenance onto its final assistant message without mutating rollout cache. */
  private withTurnSources(id: string, cached: SessionMessage[]): SessionMessage[] {
    const messages = cached.map((message) => ({ ...message }));
    const sourcesByTurn = this.workbench.listTurnSources(id);
    let turnIndex = 0;
    let lastAssistant = -1;
    const attach = () => {
      const sources = sourcesByTurn.get(turnIndex);
      if (sources?.length && lastAssistant >= 0) messages[lastAssistant]!.sources = sources;
    };
    for (const [index, message] of messages.entries()) {
      if (message.role === 'user') {
        attach();
        turnIndex += 1;
        lastAssistant = -1;
      } else if (turnIndex > 0) {
        lastAssistant = index;
      }
    }
    attach();
    return messages;
  }

  /**
   * 把本地补记的 turn 失败按时间序 merge 进回放消息：rollout 没有 error 记录的失败
   * （如 provider 直接拒流）刷新后仍能渲染错误卡。rollout 已落盘同一条错误
   * （stopReason 'error' 且 errorMessage 相同）时跳过补记，避免重复出两张错误卡。
   */
  private withTurnFailures(id: string, messages: SessionMessage[]): SessionMessage[] {
    const failures = this.workbench.listTurnFailures(id);
    if (!failures.length) return messages;
    const merged = [...messages];
    for (const failure of failures) {
      const duplicated = merged.some(
        (message) =>
          message.role === 'assistant' &&
          message.stopReason === 'error' &&
          message.errorMessage === failure.errorMessage,
      );
      if (duplicated) continue;
      const record: SessionMessage = {
        id: `turn_failure_${failure.id}`,
        role: 'assistant',
        content: '',
        stopReason: 'error',
        errorMessage: failure.errorMessage,
        ...(failure.kind ? { errorKind: failure.kind } : {}),
        ...(failure.resetAt ? { errorResetAt: failure.resetAt } : {}),
        timestamp: failure.timestamp,
      };
      // ISO 时间戳可按字符串比较；空时间戳（''）最小，自然排在补记之前。
      let index = merged.length;
      while (index > 0 && merged[index - 1]!.timestamp > failure.timestamp) index -= 1;
      merged.splice(index, 0, record);
    }
    return merged;
  }

  private recordFromEntry(id: string, entry: WorkbenchSessionEntry): SessionRecord {
    const messages = entry.threadId ? this.messagesForThread(entry.threadId) : [];
    const firstQuestion = messages
      .find((message) => message.role === 'user')
      ?.content.trim()
      .slice(0, 40);
    const title = entry.title?.trim() || firstQuestion || '新会话';
    const rolloutFile = entry.threadId ? this.findRolloutFile(entry.threadId) : undefined;
    let updatedAt = entry.updatedAt;
    if (rolloutFile) {
      // 进行中的 turn 只推进 rollout 文件 mtime，summary 的 updatedAt 跟随它。
      const modified = statSync(rolloutFile).mtime.toISOString();
      if (modified > updatedAt) updatedAt = modified;
    }
    const preview = previewFromMessages(messages);
    return {
      id,
      agentId: entry.agentId,
      title,
      createdAt: entry.createdAt,
      updatedAt,
      questionCount: messages.filter((message) => message.role === 'user').length,
      ...attentionFromMessages(messages),
      ...(preview ? { preview } : {}),
      read: entry.read ?? false,
      ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
      ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
    };
  }
}

/** resolve(cwd)+sessionDir 作为缓存键（\n 分隔，避免两段路径直接拼接产生歧义）。 */
const agentSessionStores = new Map<string, AgentSessionStore>();

/**
 * 按 cwd+sessionDir 共享 AgentSessionStore：createCodexAgentSession 每开一条会话就
 * new 一个 store 意味着每条会话各持一条 sqlite 连接，且 registry 淘汰时不会释放。
 * 共享实例生命周期跟随进程；测试仍可直接 new AgentSessionStore(...) 绕开缓存。
 */
export function agentSessionStoreFor(options: AgentSessionStoreOptions): AgentSessionStore {
  const cwd = resolve(options.cwd);
  const sessionDir = resolve(cwd, options.sessionDir ?? getCodexSessionDir(cwd));
  const key = `${cwd}\n${sessionDir}`;
  let store = agentSessionStores.get(key);
  if (!store) {
    store = new AgentSessionStore({ cwd, sessionDir });
    agentSessionStores.set(key, store);
  }
  return store;
}
