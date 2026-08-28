import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Visibility = 'public' | 'private';
export type ProjectSource = 'filesystem' | 'git';
export type ProjectStatus = 'idle' | 'syncing' | 'ready' | 'error' | 'archived';
export type AutomationKind = 'schedule' | 'api' | 'event';
export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'error';
export type ChannelStatus = 'disconnected' | 'connected' | 'error';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowRunStatus = RunStatus | 'waiting_input';
export type ConnectorTransport = 'stdio' | 'http';
export type ConnectorStatus = 'disabled' | 'ready' | 'error';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'never' | 'untrusted' | 'on-request' | 'on-failure';
export type GuardMode = 'deny' | 'ask' | 'allow';
export type HumanActionSource = 'workflow' | 'codex';
export type HumanActionStatus = 'pending' | 'handled' | 'ignored';

export interface Project {
  id: string;
  visibility: Visibility;
  wakerId: string;
  name: string;
  description: string;
  path: string | null;
  source: ProjectSource;
  status: ProjectStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Automation {
  id: string;
  wakerId: string;
  name: string;
  kind: AutomationKind;
  schedule: string | null;
  prompt: string;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  script: string;
  status: WorkflowStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  taskId: string;
  wakerId: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  nameSnapshot: string;
  descriptionSnapshot: string;
  scriptSnapshot: string;
  status: WorkflowRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface WorkflowRunEvent {
  id: number;
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface WorkflowRunTrace {
  run: WorkflowRun;
  events: WorkflowRunEvent[];
}

export interface ConnectorTool {
  name: string;
  description?: string;
}

export interface Connector {
  id: string;
  wakerId: string;
  name: string;
  transport: ConnectorTransport;
  command: string | null;
  url: string | null;
  metadata: Record<string, unknown>;
  status: ConnectorStatus;
  tools: ConnectorTool[];
  createdAt: number;
  updatedAt: number;
}

export interface PermissionPolicy {
  wakerId: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  toolGuard: GuardMode;
  fileGuard: GuardMode;
  builtinTools: string[];
  updatedAt: number;
}

export type PermissionPolicyValue = Omit<PermissionPolicy, 'wakerId' | 'updatedAt'>;

export interface HumanAction {
  id: string;
  wakerId: string;
  source: HumanActionSource;
  sourceId: string;
  title: string;
  prompt: string;
  status: HumanActionStatus;
  result: unknown;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface SessionContext {
  sessionId: string;
  wakerId: string;
  projectId: string | null;
  workingDirectory: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDeleteImpact {
  projectId: string;
  sessionContexts: number;
  tasks: number;
}

export interface Channel {
  id: string;
  provider: string;
  name: string;
  status: ChannelStatus;
  configMetadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  title: string;
  type: string;
  status: TaskStatus;
  wakerId: string;
  projectId: string | null;
  source: string;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

type ProjectInput = Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'path' | 'error'> & {
  id?: string;
  path?: string | null;
  error?: string | null;
};
type AutomationInput = Omit<
  Automation,
  'id' | 'createdAt' | 'updatedAt' | 'schedule' | 'enabled' | 'lastRun' | 'nextRun'
> & {
  id?: string;
  schedule?: string | null;
  enabled?: boolean;
  lastRun?: number | null;
  nextRun?: number | null;
};
type WorkflowInput = Omit<Workflow, 'id' | 'createdAt' | 'updatedAt' | 'version'> & {
  id?: string;
};
type ChannelInput = Omit<Channel, 'id' | 'createdAt' | 'updatedAt' | 'configMetadata'> & {
  id?: string;
  configMetadata?: Record<string, unknown>;
};
type TaskInput = Omit<
  Task,
  'id' | 'createdAt' | 'updatedAt' | 'projectId' | 'result' | 'error' | 'startedAt' | 'completedAt'
> & {
  id?: string;
  projectId?: string | null;
  result?: string | null;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
};
type ConnectorInput = Omit<
  Connector,
  'id' | 'createdAt' | 'updatedAt' | 'command' | 'url' | 'metadata' | 'tools'
> & {
  id?: string;
  command?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
  tools?: ConnectorTool[];
};
type HumanActionInput = Pick<
  HumanAction,
  'wakerId' | 'source' | 'sourceId' | 'title' | 'prompt'
> & {
  id?: string;
};

type Row = Record<string, unknown>;

const projectStatuses = ['idle', 'syncing', 'ready', 'error', 'archived'] as const;
const projectSources = ['filesystem', 'git'] as const;
const workflowStatuses = ['draft', 'active', 'paused', 'error'] as const;
const channelStatuses = ['disconnected', 'connected', 'error'] as const;
const taskStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
const connectorStatuses = ['disabled', 'ready', 'error'] as const;
const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const approvalPolicies = ['never', 'untrusted', 'on-request', 'on-failure'] as const;
const guardModes = ['deny', 'ask', 'allow'] as const;

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  return value == null ? undefined : JSON.parse(value as string);
}

function validCronField(field: string, min: number, max: number): boolean {
  return field.split(',').every((part) => {
    const [base, stepText, extra] = part.split('/');
    if (extra !== undefined || !base) return false;
    if (stepText !== undefined) {
      const step = Number(stepText);
      if (!Number.isInteger(step) || step <= 0 || step > max) return false;
    }
    if (base === '*') return true;
    const bounds = base.split('-').map(Number);
    return (
      bounds.length <= 2 &&
      bounds.every((value) => Number.isInteger(value) && value >= min && value <= max) &&
      (bounds.length === 1 || bounds[0]! <= bounds[1]!)
    );
  });
}

/** Cron is validated for storage/display only; no scheduler is implemented here. */
export function calculateNextRun(schedule: string | null, from: number): number | null {
  if (!schedule) return null;
  if (schedule.startsWith('interval:')) {
    const interval = Number(schedule.slice('interval:'.length));
    if (!Number.isSafeInteger(interval) || interval <= 0)
      throw new Error('Invalid interval schedule');
    return from + interval;
  }
  if (schedule.startsWith('once:')) {
    const timestamp = Number(schedule.slice('once:'.length));
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
      throw new Error('Invalid once schedule');
    return timestamp > from ? timestamp : null;
  }
  const fields = schedule.trim().split(/\s+/);
  const limits = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  if (
    fields.length !== 5 ||
    fields.some((field, index) => {
      const limit = limits[index]!;
      return !validCronField(field, limit[0], limit[1]);
    })
  ) {
    throw new Error('Invalid cron schedule');
  }
  return null;
}

function requireEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid ${field}: ${value}`);
  return value as T;
}

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function assertMetadataSafe(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(secret|token|password|api.?key|credential)/i.test(key)) {
      throw new Error(`Channel metadata cannot contain secrets: ${key}`);
    }
    if (
      typeof child === 'string' &&
      (/^Bearer\s+\S+/i.test(child) ||
        /-----BEGIN .+PRIVATE KEY-----/.test(child) ||
        /\b(?:sk|rk)-[A-Za-z0-9_-]{12,}/.test(child))
    ) {
      throw new Error(`Metadata cannot contain secret values: ${key}`);
    }
    assertMetadataSafe(child);
  }
}

function validateConnector(
  value: Pick<Connector, 'transport' | 'command' | 'url' | 'metadata' | 'tools'>,
): void {
  assertMetadataSafe(value.metadata);
  assertMetadataSafe(value.tools);
  for (const tool of value.tools) requireText(tool.name, 'tool name');
  if (value.transport === 'stdio') {
    const command = requireText(value.command ?? '', 'command');
    if (
      /(?:^|\s)[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*=/i.test(command)
    ) {
      throw new Error('Connector command cannot contain secrets');
    }
  } else {
    let url: URL;
    try {
      url = new URL(requireText(value.url ?? '', 'url'));
    } catch {
      throw new Error('Invalid connector URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Connector URL must be secret-free HTTP(S)');
    }
    assertMetadataSafe(Object.fromEntries(url.searchParams));
  }
}

function project(row: Row): Project {
  return {
    id: row.id as string,
    visibility: row.visibility as Visibility,
    wakerId: row.waker_id as string,
    name: row.name as string,
    description: row.description as string,
    path: row.path as string | null,
    source: row.source as ProjectSource,
    status: row.status as ProjectStatus,
    error: row.error as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function automation(row: Row): Automation {
  return {
    id: row.id as string,
    wakerId: row.waker_id as string,
    name: row.name as string,
    kind: row.kind as AutomationKind,
    schedule: row.schedule as string | null,
    prompt: row.prompt as string,
    enabled: Boolean(row.enabled),
    lastRun: row.last_run as number | null,
    nextRun: row.next_run as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function workflow(row: Row): Workflow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    script: row.script as string,
    status: row.status as WorkflowStatus,
    version: row.version as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function automationRun(row: Row): AutomationRun {
  return {
    id: row.id as string,
    automationId: row.automation_id as string,
    taskId: row.task_id as string,
    wakerId: row.waker_id as string,
    status: row.status as RunStatus,
    input: parseJson(row.input),
    output: parseJson(row.output),
    error: row.error as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
  };
}

function workflowRun(row: Row): WorkflowRun {
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    workflowVersion: row.workflow_version as number,
    nameSnapshot: row.name_snapshot as string,
    descriptionSnapshot: row.description_snapshot as string,
    scriptSnapshot: row.script_snapshot as string,
    status: row.status as WorkflowRunStatus,
    input: parseJson(row.input),
    output: parseJson(row.output),
    error: row.error as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
  };
}

function workflowRunEvent(row: Row): WorkflowRunEvent {
  return {
    id: row.id as number,
    runId: row.run_id as string,
    sequence: row.sequence as number,
    type: row.type as string,
    payload: parseJson(row.payload),
    createdAt: row.created_at as number,
  };
}

function connector(row: Row): Connector {
  return {
    id: row.id as string,
    wakerId: row.waker_id as string,
    name: row.name as string,
    transport: row.transport as ConnectorTransport,
    command: row.command as string | null,
    url: row.url as string | null,
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    status: row.status as ConnectorStatus,
    tools: JSON.parse(row.tools as string) as ConnectorTool[],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function permissionPolicy(row: Row): PermissionPolicy {
  return {
    wakerId: row.waker_id as string,
    sandboxMode: row.sandbox_mode as SandboxMode,
    approvalPolicy: row.approval_policy as ApprovalPolicy,
    toolGuard: row.tool_guard as GuardMode,
    fileGuard: row.file_guard as GuardMode,
    builtinTools: JSON.parse(row.builtin_tools as string) as string[],
    updatedAt: row.updated_at as number,
  };
}

function humanAction(row: Row): HumanAction {
  return {
    id: row.id as string,
    wakerId: row.waker_id as string,
    source: row.source as HumanActionSource,
    sourceId: row.source_id as string,
    title: row.title as string,
    prompt: row.prompt as string,
    status: row.status as HumanActionStatus,
    result: parseJson(row.result),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    resolvedAt: row.resolved_at as number | null,
  };
}

function sessionContext(row: Row): SessionContext {
  return {
    sessionId: row.session_id as string,
    wakerId: row.waker_id as string,
    projectId: row.project_id as string | null,
    workingDirectory: row.working_directory as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function channel(row: Row): Channel {
  return {
    id: row.id as string,
    provider: row.provider as string,
    name: row.name as string,
    status: row.status as ChannelStatus,
    configMetadata: JSON.parse(row.config_metadata as string) as Record<string, unknown>,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function task(row: Row): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    type: row.type as string,
    status: row.status as TaskStatus,
    wakerId: row.waker_id as string,
    projectId: row.project_id as string | null,
    source: row.source as string,
    result: row.result as string | null,
    error: row.error as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
  };
}

export interface WorkspaceStoreOptions {
  now?: () => number;
  migrationsDir?: string;
}

export class WorkspaceStore {
  readonly db: Database.Database;
  private readonly now: () => number;

  constructor(filename: string | Buffer = ':memory:', options: WorkspaceStoreOptions = {}) {
    this.db = new Database(filename);
    this.now = options.now ?? Date.now;
    this.db.pragma('foreign_keys = ON');
    this.migrate(
      options.migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), '../migrations'),
    );
  }

  close(): void {
    this.db.close();
  }

  migrationVersions(): string[] {
    return this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => (row as Row).version as string);
  }

  private migrate(directory: string): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const apply = this.db.transaction((version: string, sql: string) => {
      this.db.exec(sql);
      this.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, this.now());
    });
    for (const filename of readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const version = filename.split('_', 1)[0]!;
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version))
        continue;
      apply(version, readFileSync(join(directory, filename), 'utf8'));
    }
  }

  createProject(input: ProjectInput): Project {
    requireText(input.wakerId, 'wakerId');
    requireText(input.name, 'name');
    requireEnum(input.visibility, ['public', 'private'], 'visibility');
    requireEnum(input.source, projectSources, 'project source');
    requireEnum(input.status, projectStatuses, 'project status');
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO projects
         (id, visibility, waker_id, name, description, path, source, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.visibility,
        input.wakerId,
        input.name.trim(),
        input.description,
        input.path ?? null,
        input.source,
        input.status,
        input.error ?? null,
        now,
        now,
      );
    return this.getProject(input.wakerId, id)!;
  }

  listProjects(viewerWakerId: string): Project[] {
    return this.db
      .prepare(
        `SELECT * FROM projects
         WHERE visibility = 'public' OR waker_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(viewerWakerId)
      .map((row) => project(row as Row));
  }

  getProject(viewerWakerId: string, id: string): Project | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ? AND (visibility = 'public' OR waker_id = ?)")
      .get(id, viewerWakerId);
    return row ? project(row as Row) : undefined;
  }

  getOwnedProject(wakerId: string, id: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ? AND waker_id = ?')
      .get(id, wakerId);
    return row ? project(row as Row) : undefined;
  }

  updateProject(
    wakerId: string,
    id: string,
    patch: Partial<Omit<ProjectInput, 'id' | 'wakerId'>>,
  ): Project | undefined {
    const current = this.db
      .prepare('SELECT * FROM projects WHERE id = ? AND waker_id = ?')
      .get(id, wakerId);
    if (!current) return undefined;
    const value = { ...project(current as Row), ...patch };
    requireText(value.name, 'name');
    requireEnum(value.visibility, ['public', 'private'], 'visibility');
    requireEnum(value.source, projectSources, 'project source');
    requireEnum(value.status, projectStatuses, 'project status');
    this.db
      .prepare(
        `UPDATE projects SET visibility=?, name=?, description=?, path=?, source=?, status=?, error=?, updated_at=?
         WHERE id=? AND waker_id=?`,
      )
      .run(
        value.visibility,
        value.name.trim(),
        value.description,
        value.path,
        value.source,
        value.status,
        value.error,
        this.now(),
        id,
        wakerId,
      );
    return this.getProject(wakerId, id);
  }

  getProjectDeleteImpact(wakerId: string, id: string): ProjectDeleteImpact | undefined {
    if (!this.getOwnedProject(wakerId, id)) return undefined;
    const count = (table: 'session_contexts' | 'tasks') =>
      (
        this.db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`)
          .get(id) as Row
      ).count as number;
    return {
      projectId: id,
      sessionContexts: count('session_contexts'),
      tasks: count('tasks'),
    };
  }

  deleteProject(wakerId: string, id: string): boolean {
    return this.db.transaction(() => {
      if (!this.getOwnedProject(wakerId, id)) return false;
      // A removed project must not leave a session able to reuse its old working directory.
      this.db.prepare('DELETE FROM session_contexts WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ? AND waker_id = ?').run(id, wakerId);
      return true;
    })();
  }

  createAutomation(input: AutomationInput): Automation {
    requireText(input.wakerId, 'wakerId');
    requireText(input.name, 'name');
    requireText(input.prompt, 'prompt');
    requireEnum(input.kind, ['schedule', 'api', 'event'], 'automation kind');
    if (input.kind === 'schedule')
      calculateNextRun(requireText(input.schedule ?? '', 'schedule'), this.now());
    const id = input.id ?? randomUUID();
    const now = this.now();
    const nextRun =
      input.enabled === false || input.kind !== 'schedule'
        ? null
        : (input.nextRun ?? calculateNextRun(input.schedule ?? null, now));
    this.db
      .prepare(
        `INSERT INTO automations
         (id, waker_id, name, kind, schedule, prompt, enabled, last_run, next_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.wakerId,
        input.name.trim(),
        input.kind,
        input.schedule ?? null,
        input.prompt.trim(),
        input.enabled === false ? 0 : 1,
        input.lastRun ?? null,
        nextRun,
        now,
        now,
      );
    return this.getAutomation(input.wakerId, id)!;
  }

  listAutomations(wakerId: string): Automation[] {
    return this.db
      .prepare('SELECT * FROM automations WHERE waker_id = ? ORDER BY updated_at DESC, id')
      .all(wakerId)
      .map((row) => automation(row as Row));
  }

  getAutomation(wakerId: string, id: string): Automation | undefined {
    const row = this.db
      .prepare('SELECT * FROM automations WHERE id = ? AND waker_id = ?')
      .get(id, wakerId);
    return row ? automation(row as Row) : undefined;
  }

  updateAutomation(
    wakerId: string,
    id: string,
    patch: Partial<Omit<AutomationInput, 'id' | 'wakerId'>>,
  ): Automation | undefined {
    const current = this.getAutomation(wakerId, id);
    if (!current) return undefined;
    const value = { ...current, ...patch };
    requireText(value.name, 'name');
    requireText(value.prompt, 'prompt');
    requireEnum(value.kind, ['schedule', 'api', 'event'], 'automation kind');
    if (value.kind === 'schedule')
      calculateNextRun(requireText(value.schedule ?? '', 'schedule'), this.now());
    const nextRun =
      value.enabled && value.kind === 'schedule'
        ? calculateNextRun(value.schedule, this.now())
        : null;
    this.db
      .prepare(
        `UPDATE automations SET name=?, kind=?, schedule=?, prompt=?, enabled=?, last_run=?, next_run=?, updated_at=?
         WHERE id=? AND waker_id=?`,
      )
      .run(
        value.name.trim(),
        value.kind,
        value.schedule,
        value.prompt.trim(),
        value.enabled ? 1 : 0,
        value.lastRun,
        nextRun,
        this.now(),
        id,
        wakerId,
      );
    return this.getAutomation(wakerId, id);
  }

  deleteAutomation(wakerId: string, id: string): boolean {
    return (
      this.db.prepare('DELETE FROM automations WHERE id = ? AND waker_id = ?').run(id, wakerId)
        .changes > 0
    );
  }

  pauseAutomation(wakerId: string, id: string): Automation | undefined {
    return this.updateAutomation(wakerId, id, { enabled: false });
  }

  resumeAutomation(wakerId: string, id: string): Automation | undefined {
    return this.updateAutomation(wakerId, id, { enabled: true });
  }

  runAutomation(wakerId: string, id: string, input?: unknown): Task {
    return this.db.transaction(() => {
      const automationValue = this.getAutomation(wakerId, id);
      if (!automationValue) throw new Error('Automation not found');
      if (!automationValue.enabled) throw new Error('Automation is disabled');
      const now = this.now();
      const taskValue = this.createTask({
        title: automationValue.name,
        type: 'automation',
        status: 'queued',
        wakerId,
        source: `automation:${id}`,
      });
      const runId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO automation_runs
         (id,automation_id,task_id,waker_id,status,input,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(runId, id, taskValue.id, wakerId, 'queued', json(input), now, now);
      const nextRun =
        automationValue.kind === 'schedule'
          ? calculateNextRun(automationValue.schedule, now)
          : null;
      this.db
        .prepare('UPDATE automations SET last_run = ?, next_run = ?, updated_at = ? WHERE id = ?')
        .run(now, nextRun, now, id);
      return taskValue;
    })();
  }

  listAutomationRuns(wakerId: string, automationId?: string): AutomationRun[] {
    const sql = automationId
      ? 'SELECT * FROM automation_runs WHERE waker_id = ? AND automation_id = ? ORDER BY created_at DESC, id'
      : 'SELECT * FROM automation_runs WHERE waker_id = ? ORDER BY created_at DESC, id';
    const rows = automationId
      ? this.db.prepare(sql).all(wakerId, automationId)
      : this.db.prepare(sql).all(wakerId);
    return rows.map((row) => automationRun(row as Row));
  }

  getAutomationRun(wakerId: string, runId: string): AutomationRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM automation_runs WHERE id = ? AND waker_id = ?')
      .get(runId, wakerId);
    return row ? automationRun(row as Row) : undefined;
  }

  getAutomationRunByTask(wakerId: string, taskId: string): AutomationRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM automation_runs WHERE task_id = ? AND waker_id = ?')
      .get(taskId, wakerId);
    return row ? automationRun(row as Row) : undefined;
  }

  startAutomationRun(wakerId: string, runId: string): AutomationRun {
    return this.db.transaction(() => {
      const run = this.requireAutomationRun(wakerId, runId, ['queued']);
      const now = this.now();
      this.db
        .prepare(
          "UPDATE automation_runs SET status='running', started_at=?, updated_at=? WHERE id=?",
        )
        .run(now, now, runId);
      this.updateTask(wakerId, run.taskId, { status: 'running', startedAt: now });
      return this.getAutomationRun(wakerId, runId)!;
    })();
  }

  completeAutomationRun(wakerId: string, runId: string, output?: unknown): AutomationRun {
    return this.finishAutomationRun(wakerId, runId, 'succeeded', output);
  }

  failAutomationRun(wakerId: string, runId: string, error: string): AutomationRun {
    requireText(error, 'error');
    return this.finishAutomationRun(wakerId, runId, 'failed', undefined, error);
  }

  cancelAutomationRun(wakerId: string, runId: string): AutomationRun {
    return this.finishAutomationRun(wakerId, runId, 'cancelled');
  }

  private requireAutomationRun(
    wakerId: string,
    runId: string,
    allowed: readonly RunStatus[],
  ): AutomationRun {
    const run = this.getAutomationRun(wakerId, runId);
    if (!run) throw new Error('Automation run not found');
    if (!allowed.includes(run.status))
      throw new Error(`Invalid automation run transition from ${run.status}`);
    return run;
  }

  private finishAutomationRun(
    wakerId: string,
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    output?: unknown,
    error?: string,
  ): AutomationRun {
    return this.db.transaction(() => {
      const allowed: RunStatus[] = status === 'cancelled' ? ['queued', 'running'] : ['running'];
      const run = this.requireAutomationRun(wakerId, runId, allowed);
      const now = this.now();
      this.db
        .prepare(
          'UPDATE automation_runs SET status=?, output=?, error=?, completed_at=?, updated_at=? WHERE id=?',
        )
        .run(status, json(output), error ?? null, now, now, runId);
      const taskStatus: TaskStatus =
        status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled';
      this.updateTask(wakerId, run.taskId, {
        status: taskStatus,
        result: json(output),
        error: error ?? null,
        completedAt: now,
      });
      return this.getAutomationRun(wakerId, runId)!;
    })();
  }

  createWorkflow(input: WorkflowInput): Workflow {
    requireText(input.name, 'name');
    requireEnum(input.status, workflowStatuses, 'workflow status');
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        'INSERT INTO workflows (id,name,description,script,status,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)',
      )
      .run(id, input.name.trim(), input.description, input.script, input.status, now, now);
    return this.getWorkflow(id)!;
  }

  listWorkflows(): Workflow[] {
    return this.db
      .prepare('SELECT * FROM workflows ORDER BY updated_at DESC, id')
      .all()
      .map((row) => workflow(row as Row));
  }

  getWorkflow(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    return row ? workflow(row as Row) : undefined;
  }

  updateWorkflow(id: string, patch: Partial<Omit<WorkflowInput, 'id'>>): Workflow | undefined {
    const current = this.getWorkflow(id);
    if (!current) return undefined;
    const value = { ...current, ...patch };
    requireText(value.name, 'name');
    requireEnum(value.status, workflowStatuses, 'workflow status');
    this.db
      .prepare(
        'UPDATE workflows SET name=?,description=?,script=?,status=?,version=version+1,updated_at=? WHERE id=?',
      )
      .run(value.name.trim(), value.description, value.script, value.status, this.now(), id);
    return this.getWorkflow(id);
  }

  deleteWorkflow(id: string): boolean {
    return this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes > 0;
  }

  runWorkflow(workflowId: string, input?: unknown): WorkflowRun {
    return this.db.transaction(() => {
      const value = this.getWorkflow(workflowId);
      if (!value) throw new Error('Workflow not found');
      if (value.status !== 'active') throw new Error('Workflow is not active');
      const id = randomUUID();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO workflow_runs
         (id,workflow_id,workflow_version,name_snapshot,description_snapshot,script_snapshot,status,input,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          workflowId,
          value.version,
          value.name,
          value.description,
          value.script,
          'queued',
          json(input),
          now,
          now,
        );
      this.appendWorkflowRunEvent(id, 'queued', input);
      return this.getWorkflowRun(id)!;
    })();
  }

  listWorkflowRuns(workflowId?: string): WorkflowRun[] {
    const rows = workflowId
      ? this.db
          .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC, id')
          .all(workflowId)
      : this.db.prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC, id').all();
    return rows.map((row) => workflowRun(row as Row));
  }

  getWorkflowRun(runId: string): WorkflowRun | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId);
    return row ? workflowRun(row as Row) : undefined;
  }

  startWorkflowRun(runId: string): WorkflowRun {
    return this.db.transaction(() => {
      this.requireWorkflowRun(runId, ['queued']);
      const now = this.now();
      this.db
        .prepare("UPDATE workflow_runs SET status='running', started_at=?, updated_at=? WHERE id=?")
        .run(now, now, runId);
      this.appendWorkflowRunEvent(runId, 'started');
      return this.getWorkflowRun(runId)!;
    })();
  }

  appendWorkflowRunEvent(runId: string, type: string, payload?: unknown): WorkflowRunEvent {
    requireText(type, 'event type');
    const run = this.getWorkflowRun(runId);
    if (!run) throw new Error('Workflow run not found');
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      throw new Error(`Cannot append event to ${run.status} workflow run`);
    }
    const sequence =
      (((
        this.db
          .prepare('SELECT MAX(sequence) AS value FROM workflow_run_events WHERE run_id = ?')
          .get(runId) as Row
      ).value as number | null) ?? 0) + 1;
    const result = this.db
      .prepare(
        'INSERT INTO workflow_run_events (run_id,sequence,type,payload,created_at) VALUES (?,?,?,?,?)',
      )
      .run(runId, sequence, type.trim(), json(payload), this.now());
    return workflowRunEvent(
      this.db
        .prepare('SELECT * FROM workflow_run_events WHERE id = ?')
        .get(result.lastInsertRowid) as Row,
    );
  }

  waitForWorkflowInput(runId: string, prompt?: unknown): WorkflowRun {
    return this.db.transaction(() => {
      this.requireWorkflowRun(runId, ['running']);
      this.db
        .prepare("UPDATE workflow_runs SET status='waiting_input', updated_at=? WHERE id=?")
        .run(this.now(), runId);
      this.appendWorkflowRunEvent(runId, 'waiting_input', prompt);
      return this.getWorkflowRun(runId)!;
    })();
  }

  resumeWorkflowRun(runId: string, input?: unknown): WorkflowRun {
    return this.db.transaction(() => {
      this.requireWorkflowRun(runId, ['waiting_input']);
      this.db
        .prepare("UPDATE workflow_runs SET status='running', updated_at=? WHERE id=?")
        .run(this.now(), runId);
      this.appendWorkflowRunEvent(runId, 'resumed', input);
      return this.getWorkflowRun(runId)!;
    })();
  }

  completeWorkflowRun(runId: string, output?: unknown): WorkflowRun {
    return this.finishWorkflowRun(runId, 'succeeded', output);
  }

  failWorkflowRun(runId: string, error: string): WorkflowRun {
    requireText(error, 'error');
    return this.finishWorkflowRun(runId, 'failed', undefined, error);
  }

  cancelWorkflowRun(runId: string): WorkflowRun {
    return this.finishWorkflowRun(runId, 'cancelled');
  }

  listWorkflowRunEvents(runId: string): WorkflowRunEvent[] {
    if (!this.getWorkflowRun(runId)) throw new Error('Workflow run not found');
    return this.db
      .prepare('SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY sequence')
      .all(runId)
      .map((row) => workflowRunEvent(row as Row));
  }

  getWorkflowRunTrace(runId: string): WorkflowRunTrace {
    const run = this.getWorkflowRun(runId);
    if (!run) throw new Error('Workflow run not found');
    return { run, events: this.listWorkflowRunEvents(runId) };
  }

  private requireWorkflowRun(runId: string, allowed: readonly WorkflowRunStatus[]): WorkflowRun {
    const run = this.getWorkflowRun(runId);
    if (!run) throw new Error('Workflow run not found');
    if (!allowed.includes(run.status))
      throw new Error(`Invalid workflow run transition from ${run.status}`);
    return run;
  }

  private finishWorkflowRun(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    output?: unknown,
    error?: string,
  ): WorkflowRun {
    return this.db.transaction(() => {
      const allowed: WorkflowRunStatus[] =
        status === 'cancelled' ? ['queued', 'running', 'waiting_input'] : ['running'];
      this.requireWorkflowRun(runId, allowed);
      const now = this.now();
      this.appendWorkflowRunEvent(runId, status, status === 'failed' ? { error } : output);
      this.db
        .prepare(
          'UPDATE workflow_runs SET status=?,output=?,error=?,completed_at=?,updated_at=? WHERE id=?',
        )
        .run(status, json(output), error ?? null, now, now, runId);
      return this.getWorkflowRun(runId)!;
    })();
  }

  createChannel(input: ChannelInput): Channel {
    requireText(input.provider, 'provider');
    requireText(input.name, 'name');
    requireEnum(input.status, channelStatuses, 'channel status');
    const metadata = input.configMetadata ?? {};
    assertMetadataSafe(metadata);
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        'INSERT INTO channels (id,provider,name,status,config_metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.provider.trim(),
        input.name.trim(),
        input.status,
        JSON.stringify(metadata),
        now,
        now,
      );
    return this.getChannel(id)!;
  }

  listChannels(): Channel[] {
    return this.db
      .prepare('SELECT * FROM channels ORDER BY updated_at DESC, id')
      .all()
      .map((row) => channel(row as Row));
  }

  getChannel(id: string): Channel | undefined {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
    return row ? channel(row as Row) : undefined;
  }

  updateChannel(id: string, patch: Partial<Omit<ChannelInput, 'id'>>): Channel | undefined {
    const current = this.getChannel(id);
    if (!current) return undefined;
    const value = { ...current, ...patch };
    requireText(value.provider, 'provider');
    requireText(value.name, 'name');
    requireEnum(value.status, channelStatuses, 'channel status');
    assertMetadataSafe(value.configMetadata);
    this.db
      .prepare(
        'UPDATE channels SET provider=?,name=?,status=?,config_metadata=?,updated_at=? WHERE id=?',
      )
      .run(
        value.provider.trim(),
        value.name.trim(),
        value.status,
        JSON.stringify(value.configMetadata),
        this.now(),
        id,
      );
    return this.getChannel(id);
  }

  deleteChannel(id: string): boolean {
    return this.db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes > 0;
  }

  createConnector(input: ConnectorInput): Connector {
    requireText(input.wakerId, 'wakerId');
    requireText(input.name, 'name');
    requireEnum(input.transport, ['stdio', 'http'], 'connector transport');
    requireEnum(input.status, connectorStatuses, 'connector status');
    const value = {
      command: input.command ?? null,
      url: input.url ?? null,
      metadata: input.metadata ?? {},
      tools: input.tools ?? [],
      transport: input.transport,
    };
    validateConnector(value);
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO connectors
       (id,waker_id,name,transport,command,url,metadata,status,tools,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.wakerId,
        input.name.trim(),
        input.transport,
        value.command,
        value.url,
        JSON.stringify(value.metadata),
        input.status,
        JSON.stringify(value.tools),
        now,
        now,
      );
    return this.getConnector(input.wakerId, id)!;
  }

  listConnectors(wakerId: string): Connector[] {
    return this.db
      .prepare('SELECT * FROM connectors WHERE waker_id = ? ORDER BY updated_at DESC, id')
      .all(wakerId)
      .map((row) => connector(row as Row));
  }

  getConnector(wakerId: string, id: string): Connector | undefined {
    const row = this.db
      .prepare('SELECT * FROM connectors WHERE id = ? AND waker_id = ?')
      .get(id, wakerId);
    return row ? connector(row as Row) : undefined;
  }

  updateConnector(
    wakerId: string,
    id: string,
    patch: Partial<Omit<ConnectorInput, 'id' | 'wakerId'>>,
  ): Connector | undefined {
    const current = this.getConnector(wakerId, id);
    if (!current) return undefined;
    const value = { ...current, ...patch };
    requireText(value.name, 'name');
    requireEnum(value.transport, ['stdio', 'http'], 'connector transport');
    requireEnum(value.status, connectorStatuses, 'connector status');
    validateConnector(value);
    this.db
      .prepare(
        `UPDATE connectors SET name=?,transport=?,command=?,url=?,metadata=?,status=?,tools=?,updated_at=?
       WHERE id=? AND waker_id=?`,
      )
      .run(
        value.name.trim(),
        value.transport,
        value.command,
        value.url,
        JSON.stringify(value.metadata),
        value.status,
        JSON.stringify(value.tools),
        this.now(),
        id,
        wakerId,
      );
    return this.getConnector(wakerId, id);
  }

  enableConnector(wakerId: string, id: string): Connector | undefined {
    return this.updateConnector(wakerId, id, { status: 'ready' });
  }

  disableConnector(wakerId: string, id: string): Connector | undefined {
    return this.updateConnector(wakerId, id, { status: 'disabled' });
  }

  deleteConnector(wakerId: string, id: string): boolean {
    return (
      this.db.prepare('DELETE FROM connectors WHERE id = ? AND waker_id = ?').run(id, wakerId)
        .changes > 0
    );
  }

  setPermissionPolicy(
    wakerId: string,
    value: PermissionPolicyValue,
    host: PermissionPolicyValue,
  ): PermissionPolicy {
    requireText(wakerId, 'wakerId');
    requireEnum(value.sandboxMode, sandboxModes, 'sandbox mode');
    requireEnum(value.approvalPolicy, approvalPolicies, 'approval policy');
    requireEnum(value.toolGuard, guardModes, 'tool guard');
    requireEnum(value.fileGuard, guardModes, 'file guard');
    requireEnum(host.sandboxMode, sandboxModes, 'host sandbox mode');
    requireEnum(host.approvalPolicy, approvalPolicies, 'host approval policy');
    requireEnum(host.toolGuard, guardModes, 'host tool guard');
    requireEnum(host.fileGuard, guardModes, 'host file guard');
    const noBroader = <T extends string>(
      selected: T,
      baseline: T,
      ordered: readonly T[],
      field: string,
    ) => {
      if (ordered.indexOf(selected) > ordered.indexOf(baseline))
        throw new Error(`${field} cannot broaden host policy`);
    };
    noBroader(value.sandboxMode, host.sandboxMode, sandboxModes, 'sandboxMode');
    noBroader(value.approvalPolicy, host.approvalPolicy, approvalPolicies, 'approvalPolicy');
    noBroader(value.toolGuard, host.toolGuard, guardModes, 'toolGuard');
    noBroader(value.fileGuard, host.fileGuard, guardModes, 'fileGuard');
    const tools = [...new Set(value.builtinTools.map((tool) => requireText(tool, 'builtin tool')))];
    if (tools.some((tool) => !host.builtinTools.includes(tool)))
      throw new Error('builtinTools cannot broaden host policy');
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO permission_policies
       (waker_id,sandbox_mode,approval_policy,tool_guard,file_guard,builtin_tools,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(waker_id) DO UPDATE SET
       sandbox_mode=excluded.sandbox_mode, approval_policy=excluded.approval_policy,
       tool_guard=excluded.tool_guard, file_guard=excluded.file_guard,
       builtin_tools=excluded.builtin_tools, updated_at=excluded.updated_at`,
      )
      .run(
        wakerId,
        value.sandboxMode,
        value.approvalPolicy,
        value.toolGuard,
        value.fileGuard,
        JSON.stringify(tools),
        now,
      );
    return this.getPermissionPolicy(wakerId)!;
  }

  getPermissionPolicy(wakerId: string): PermissionPolicy | undefined {
    const row = this.db
      .prepare('SELECT * FROM permission_policies WHERE waker_id = ?')
      .get(wakerId);
    return row ? permissionPolicy(row as Row) : undefined;
  }

  deletePermissionPolicy(wakerId: string): boolean {
    return (
      this.db.prepare('DELETE FROM permission_policies WHERE waker_id = ?').run(wakerId).changes > 0
    );
  }

  createHumanAction(input: HumanActionInput): HumanAction {
    requireText(input.wakerId, 'wakerId');
    requireText(input.sourceId, 'sourceId');
    requireText(input.title, 'title');
    requireEnum(input.source, ['workflow', 'codex'], 'human action source');
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO human_actions
       (id,waker_id,source,source_id,title,prompt,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(
        id,
        input.wakerId,
        input.source,
        input.sourceId,
        input.title.trim(),
        input.prompt,
        now,
        now,
      );
    return this.getHumanAction(input.wakerId, id)!;
  }

  listHumanActions(wakerId: string, status?: HumanActionStatus): HumanAction[] {
    if (status) requireEnum(status, ['pending', 'handled', 'ignored'], 'human action status');
    const rows = status
      ? this.db
          .prepare(
            'SELECT * FROM human_actions WHERE waker_id = ? AND status = ? ORDER BY created_at DESC, id',
          )
          .all(wakerId, status)
      : this.db
          .prepare('SELECT * FROM human_actions WHERE waker_id = ? ORDER BY created_at DESC, id')
          .all(wakerId);
    return rows.map((row) => humanAction(row as Row));
  }

  getHumanAction(wakerId: string, id: string): HumanAction | undefined {
    const row = this.db
      .prepare('SELECT * FROM human_actions WHERE id = ? AND waker_id = ?')
      .get(id, wakerId);
    return row ? humanAction(row as Row) : undefined;
  }

  updateHumanAction(
    wakerId: string,
    id: string,
    patch: Partial<Pick<HumanActionInput, 'title' | 'prompt'>>,
  ): HumanAction | undefined {
    const current = this.getHumanAction(wakerId, id);
    if (!current) return undefined;
    if (current.status !== 'pending') throw new Error('Only pending human actions can be updated');
    const title = patch.title ?? current.title;
    requireText(title, 'title');
    this.db
      .prepare('UPDATE human_actions SET title=?,prompt=?,updated_at=? WHERE id=? AND waker_id=?')
      .run(title.trim(), patch.prompt ?? current.prompt, this.now(), id, wakerId);
    return this.getHumanAction(wakerId, id);
  }

  resolveHumanAction(wakerId: string, id: string, result: unknown): HumanAction {
    if (result === undefined) throw new Error('result is required');
    return this.finishHumanAction(wakerId, id, 'handled', result);
  }

  ignoreHumanAction(wakerId: string, id: string): HumanAction {
    return this.finishHumanAction(wakerId, id, 'ignored');
  }

  private finishHumanAction(
    wakerId: string,
    id: string,
    status: 'handled' | 'ignored',
    result?: unknown,
  ): HumanAction {
    const current = this.getHumanAction(wakerId, id);
    if (!current) throw new Error('Human action not found');
    if (current.status !== 'pending')
      throw new Error(`Invalid human action transition from ${current.status}`);
    const now = this.now();
    this.db
      .prepare(
        'UPDATE human_actions SET status=?,result=?,resolved_at=?,updated_at=? WHERE id=? AND waker_id=?',
      )
      .run(status, json(result), now, now, id, wakerId);
    return this.getHumanAction(wakerId, id)!;
  }

  deleteHumanAction(wakerId: string, id: string): boolean {
    return (
      this.db.prepare('DELETE FROM human_actions WHERE id = ? AND waker_id = ?').run(id, wakerId)
        .changes > 0
    );
  }

  bindSessionContext(
    input: Pick<SessionContext, 'sessionId' | 'wakerId' | 'projectId' | 'workingDirectory'>,
  ): SessionContext {
    requireText(input.sessionId, 'sessionId');
    requireText(input.wakerId, 'wakerId');
    const existing = this.db
      .prepare('SELECT waker_id FROM session_contexts WHERE session_id = ?')
      .get(input.sessionId) as Row | undefined;
    if (existing && existing.waker_id !== input.wakerId)
      throw new Error('Session context belongs to another Waker');
    if (input.projectId && !this.getProject(input.wakerId, input.projectId))
      throw new Error('Project is not visible to Waker');
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO session_contexts
       (session_id,waker_id,project_id,working_directory,created_at,updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
       project_id=excluded.project_id, working_directory=excluded.working_directory,
       updated_at=excluded.updated_at`,
      )
      .run(input.sessionId, input.wakerId, input.projectId, input.workingDirectory, now, now);
    return this.getSessionContext(input.wakerId, input.sessionId)!;
  }

  getSessionContext(wakerId: string, sessionId: string): SessionContext | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_contexts WHERE session_id = ? AND waker_id = ?')
      .get(sessionId, wakerId);
    return row ? sessionContext(row as Row) : undefined;
  }

  deleteSessionContext(wakerId: string, sessionId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM session_contexts WHERE session_id = ? AND waker_id = ?')
        .run(sessionId, wakerId).changes > 0
    );
  }

  createTask(input: TaskInput): Task {
    requireText(input.title, 'title');
    requireText(input.type, 'type');
    requireText(input.wakerId, 'wakerId');
    requireEnum(input.status, taskStatuses, 'task status');
    if (input.status === 'completed' && input.completedAt == null)
      throw new Error('completedAt is required');
    if (input.status === 'failed' && (input.completedAt == null || !input.error))
      throw new Error('failed task requires error and completedAt');
    if (input.projectId) {
      const owner = this.db
        .prepare('SELECT waker_id FROM projects WHERE id = ?')
        .get(input.projectId) as Row | undefined;
      if (!owner || owner.waker_id !== input.wakerId)
        throw new Error('Project does not belong to Waker');
    }
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks
         (id,title,type,status,waker_id,project_id,source,result,error,created_at,updated_at,started_at,completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.title.trim(),
        input.type.trim(),
        input.status,
        input.wakerId,
        input.projectId ?? null,
        input.source,
        input.result ?? null,
        input.error ?? null,
        now,
        now,
        input.startedAt ?? null,
        input.completedAt ?? null,
      );
    return this.getTask(input.wakerId, id)!;
  }

  listTasks(wakerId: string, filter: { projectId?: string; status?: TaskStatus } = {}): Task[] {
    const conditions = ['waker_id = ?'];
    const values: unknown[] = [wakerId];
    if (filter.projectId !== undefined) {
      conditions.push('project_id = ?');
      values.push(filter.projectId);
    }
    if (filter.status !== undefined) {
      requireEnum(filter.status, taskStatuses, 'task status');
      conditions.push('status = ?');
      values.push(filter.status);
    }
    return this.db
      .prepare(`SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id`)
      .all(...values)
      .map((row) => task(row as Row));
  }

  getTask(wakerId: string, id: string): Task | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ? AND waker_id = ?')
      .get(id, wakerId);
    return row ? task(row as Row) : undefined;
  }

  updateTask(
    wakerId: string,
    id: string,
    patch: Partial<Omit<TaskInput, 'id' | 'wakerId'>>,
  ): Task | undefined {
    const current = this.getTask(wakerId, id);
    if (!current) return undefined;
    const value = { ...current, ...patch };
    requireText(value.title, 'title');
    requireText(value.type, 'type');
    requireEnum(value.status, taskStatuses, 'task status');
    if (value.status === 'completed' && value.completedAt == null)
      throw new Error('completedAt is required');
    if (value.status === 'failed' && (value.completedAt == null || !value.error))
      throw new Error('failed task requires error and completedAt');
    if (value.projectId) {
      const owner = this.db
        .prepare('SELECT waker_id FROM projects WHERE id = ?')
        .get(value.projectId) as Row | undefined;
      if (!owner || owner.waker_id !== wakerId) throw new Error('Project does not belong to Waker');
    }
    this.db
      .prepare(
        `UPDATE tasks SET title=?,type=?,status=?,project_id=?,source=?,result=?,error=?,started_at=?,completed_at=?,updated_at=?
         WHERE id=? AND waker_id=?`,
      )
      .run(
        value.title.trim(),
        value.type.trim(),
        value.status,
        value.projectId,
        value.source,
        value.result,
        value.error,
        value.startedAt,
        value.completedAt,
        this.now(),
        id,
        wakerId,
      );
    return this.getTask(wakerId, id);
  }

  deleteTask(wakerId: string, id: string): boolean {
    return (
      this.db.prepare('DELETE FROM tasks WHERE id = ? AND waker_id = ?').run(id, wakerId).changes >
      0
    );
  }
}
