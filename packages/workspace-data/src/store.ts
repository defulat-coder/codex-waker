import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { calculateNextRun, type MisfirePolicy, validateTimeZone } from './schedule.js';
import {
  normalizeWorkflowDefinition,
  serializeWorkflowDefinition,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowReference,
  type WorkflowThinkingLevel,
} from './workflow.js';

export { calculateNextRun, calculatePreviousRun, validateTimeZone } from './schedule.js';
export type { MisfirePolicy, ScheduleBounds } from './schedule.js';

export type Visibility = 'public' | 'private';
export type ProjectSource = 'filesystem' | 'git';
export type ProjectStatus = 'idle' | 'syncing' | 'ready' | 'error' | 'archived';
export type AutomationKind = 'schedule' | 'api' | 'event';
export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'error';
export type ChannelStatus = 'disconnected' | 'connected' | 'error';
export type TaskStatus = 'queued' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskType = 'manual' | 'conversation' | 'automation' | 'workflow';
export type TaskOrigin = 'manual' | 'derived';
export type TaskSourceType = 'manual' | 'conversation' | 'automation' | 'workflow';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AutomationRunStatus = RunStatus | 'skipped';
export type AutomationRunTrigger = 'manual' | 'scheduled';
export type AutomationThinkingLevel =
  'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const automationMisfireGraceMs = 60_000;
export type WorkflowRunStatus = RunStatus | 'paused' | 'waiting_input' | 'waiting_child';
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
  projectId: string | null;
  model: string | null;
  thinking: AutomationThinkingLevel | null;
  enabled: boolean;
  timezone: string;
  startAt: number | null;
  endAt: number | null;
  maxRuns: number | null;
  runCount: number;
  misfirePolicy: MisfirePolicy;
  lastRun: number | null;
  lastScheduledAt: number | null;
  nextRun: number | null;
  completedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Workflow {
  id: string;
  wakerId: string;
  projectId: string | null;
  model: string | null;
  thinking: WorkflowThinkingLevel | null;
  name: string;
  description: string;
  script: string;
  definition: WorkflowDefinition | null;
  validationErrors: string[];
  status: WorkflowStatus;
  version: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowVersionOperation = 'create' | 'update' | 'rollback' | 'legacy';

export interface WorkflowVersion {
  workflowId: string;
  version: number;
  wakerId: string;
  projectId: string | null;
  model: string | null;
  thinking: WorkflowThinkingLevel | null;
  name: string;
  description: string;
  definition: WorkflowDefinition | null;
  status: WorkflowStatus;
  validationErrors: string[];
  operation: WorkflowVersionOperation;
  createdAt: number;
}

export interface WorkflowDeleteImpact {
  workflowId: string;
  versions: number;
  runs: number;
  activeRuns: number;
  referencedBy: string[];
}

export interface WorkflowMutationPreview {
  applied: boolean;
  workflow: Workflow;
  diff: string;
}

export interface WorkflowDefinitionValidation {
  valid: boolean;
  definition?: WorkflowDefinition;
  script?: string;
  errors: string[];
}

export class WorkflowConflictError extends Error {
  constructor(expectedVersion: number, currentVersion: number) {
    super(`Workflow version conflict: expected ${expectedVersion}, current ${currentVersion}`);
    this.name = 'WorkflowConflictError';
  }
}

export class TaskConflictError extends Error {
  constructor(expectedVersion: number, currentVersion: number) {
    super(`Task version conflict: expected ${expectedVersion}, current ${currentVersion}`);
    this.name = 'TaskConflictError';
  }
}

export class HumanActionConflictError extends Error {
  constructor(expectedVersion: number, currentVersion: number) {
    super(`Human Action version conflict: expected ${expectedVersion}, current ${currentVersion}`);
    this.name = 'HumanActionConflictError';
  }
}

export interface AutomationRun {
  id: string;
  automationId: string;
  taskId: string;
  wakerId: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  scheduledFor: number | null;
  nameSnapshot: string;
  promptSnapshot: string;
  projectId: string | null;
  sessionId: string | null;
  model: string | null;
  thinking: AutomationThinkingLevel | null;
  input: unknown;
  output: unknown;
  result: unknown;
  usage: unknown;
  error: string | null;
  attempt: number;
  retryOfRunId: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface AutomationDeleteImpact {
  automationId: string;
  runs: number;
  tasks: number;
  sessions: number;
}

export interface WorkflowRun {
  id: string;
  taskId: string;
  workflowId: string;
  workflowVersion: number;
  nameSnapshot: string;
  descriptionSnapshot: string;
  scriptSnapshot: string;
  definitionSnapshot: WorkflowDefinition | null;
  wakerId: string;
  projectId: string | null;
  model: string | null;
  thinking: WorkflowThinkingLevel | null;
  sessionId: string | null;
  parentRunId: string | null;
  parentNodeId: string | null;
  childRunId: string | null;
  depth: number;
  attempt: number;
  retryOfRunId: string | null;
  currentNodeId: string | null;
  context: Record<string, unknown>;
  wakeAt: number | null;
  waitingActionId: string | null;
  status: WorkflowRunStatus;
  input: unknown;
  output: unknown;
  result: unknown;
  usage: unknown;
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
  taskId: string | null;
  sessionId: string | null;
  kind: 'confirm' | 'input';
  title: string;
  prompt: string;
  status: HumanActionStatus;
  result: unknown;
  version: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  deletedAt: number | null;
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
  tasksPreserved: number;
  automationDefinitions: number;
  automationRuns: number;
  automationTasksPreserved: number;
  workflowDefinitions: number;
  workflowRuns: number;
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
  description: string;
  type: TaskType;
  origin: TaskOrigin;
  status: TaskStatus;
  priority: TaskPriority;
  position: number;
  version: number;
  wakerId: string;
  projectId: string | null;
  sourceType: TaskSourceType;
  sourceId: string;
  source: string;
  runId: string | null;
  sessionId: string | null;
  parentTaskId: string | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  startedAt: number | null;
  completedAt: number | null;
  deletedAt: number | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  wakerId: string;
  sequence: number;
  type: string;
  status: TaskStatus | null;
  payload: unknown;
  createdAt: number;
}

export interface TaskListFilter {
  projectId?: string;
  status?: TaskStatus;
  statuses?: readonly TaskStatus[];
  types?: readonly TaskType[];
  sourceTypes?: readonly TaskSourceType[];
  query?: string;
  parentTaskId?: string | null;
  priority?: TaskPriority;
  sort?: 'updated_desc' | 'updated_asc' | 'priority_desc' | 'title_asc';
  limit?: number;
  offset?: number;
}

export interface TaskPage {
  items: Task[];
  total: number;
}

export interface TaskDetail {
  task: Task;
  events: TaskEvent[];
  children: Task[];
  humanActions: HumanAction[];
}

export interface TaskDeleteImpact {
  taskId: string;
  children: number;
  events: number;
  humanActions: number;
  behavior: 'soft-delete';
}

export interface HumanActionListFilter {
  status?: HumanActionStatus;
  source?: HumanActionSource;
  taskId?: string;
  limit?: number;
  offset?: number;
}

export interface HumanActionPage {
  items: HumanAction[];
  total: number;
}

type ProjectInput = Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'path' | 'error'> & {
  id?: string;
  path?: string | null;
  error?: string | null;
};
type AutomationInput = Omit<
  Automation,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'schedule'
  | 'enabled'
  | 'timezone'
  | 'startAt'
  | 'endAt'
  | 'maxRuns'
  | 'runCount'
  | 'misfirePolicy'
  | 'lastRun'
  | 'lastScheduledAt'
  | 'nextRun'
  | 'completedAt'
  | 'deletedAt'
  | 'projectId'
  | 'model'
  | 'thinking'
> & {
  id?: string;
  schedule?: string | null;
  enabled?: boolean;
  timezone?: string;
  startAt?: number | null;
  endAt?: number | null;
  maxRuns?: number | null;
  misfirePolicy?: MisfirePolicy;
  lastRun?: number | null;
  projectId?: string | null;
  model?: string | null;
  thinking?: AutomationThinkingLevel | null;
};

export interface EnqueueAutomationRunInput {
  trigger: AutomationRunTrigger;
  input?: unknown;
  projectId?: string | null;
  model?: string | null;
  thinking?: AutomationThinkingLevel | null;
}
export interface WorkflowCreateInput {
  id?: string;
  wakerId: string;
  projectId?: string | null;
  model?: string | null;
  thinking?: WorkflowThinkingLevel | null;
  name: string;
  description?: string;
  definition?: unknown;
  script?: string;
  status?: Exclude<WorkflowStatus, 'error'>;
}

export interface WorkflowUpdateInput {
  expectedVersion: number;
  projectId?: string | null;
  model?: string | null;
  thinking?: WorkflowThinkingLevel | null;
  name?: string;
  description?: string;
  definition?: unknown;
  script?: string;
  status?: Exclude<WorkflowStatus, 'error'>;
}

export interface WorkflowRunOptions {
  parentRunId?: string | null;
  parentNodeId?: string | null;
  depth?: number;
  attempt?: number;
  retryOfRunId?: string | null;
}
type ChannelInput = Omit<Channel, 'id' | 'createdAt' | 'updatedAt' | 'configMetadata'> & {
  id?: string;
  configMetadata?: Record<string, unknown>;
};
export interface ManualTaskInput {
  id?: string;
  title: string;
  description?: string;
  type?: 'manual';
  status?: TaskStatus;
  wakerId: string;
  projectId?: string | null;
  source?: string;
  priority?: TaskPriority;
  position?: number;
  parentTaskId?: string | null;
  result?: string | null;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface ManualTaskUpdate {
  expectedVersion: number;
  title?: string;
  description?: string;
  status?: TaskStatus;
  projectId?: string | null;
  priority?: TaskPriority;
  position?: number;
  parentTaskId?: string | null;
  result?: string | null;
  error?: string | null;
}
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
  taskId?: string | null;
  sessionId?: string | null;
  kind?: HumanAction['kind'];
};

type Row = Record<string, unknown>;

const projectStatuses = ['idle', 'syncing', 'ready', 'error', 'archived'] as const;
const projectSources = ['filesystem', 'git'] as const;
const workflowThinkingLevels = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
const channelStatuses = ['disconnected', 'connected', 'error'] as const;
const taskStatuses = ['queued', 'waiting', 'running', 'completed', 'failed', 'cancelled'] as const;
const taskTypes = ['manual', 'conversation', 'automation', 'workflow'] as const;
const taskSourceTypes = ['manual', 'conversation', 'automation', 'workflow'] as const;
const taskPriorities = ['low', 'normal', 'high', 'urgent'] as const;
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

const unsafeWorkflowContextParts = new Set(['__proto__', 'prototype', 'constructor']);

function setWorkflowContextValue(
  context: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const copy = structuredClone(context);
  const parts = key.split('.');
  if (!parts.length || parts.some((part) => !part || unsafeWorkflowContextParts.has(part))) {
    throw new Error(`Unsafe workflow context key: ${key}`);
  }
  let target = copy;
  for (const part of parts.slice(0, -1)) {
    const current = target[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) target[part] = {};
    target = target[part] as Record<string, unknown>;
  }
  target[parts.at(-1)!] = value;
  return copy;
}

function workflowUsage(value: unknown): { input: number; output: number; total: number } {
  if (!value || typeof value !== 'object') return { input: 0, output: 0, total: 0 };
  const item = value as Record<string, unknown>;
  return {
    input: Number.isSafeInteger(item.input) ? (item.input as number) : 0,
    output: Number.isSafeInteger(item.output) ? (item.output as number) : 0,
    total: Number.isSafeInteger(item.total) ? (item.total as number) : 0,
  };
}

function requireEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid ${field}: ${value}`);
  return value as T;
}

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function validateAutomationSchedule(value: {
  kind: AutomationKind;
  schedule: string | null;
  timezone: string;
  startAt: number | null;
  endAt: number | null;
  maxRuns: number | null;
}): void {
  if (value.maxRuns !== null && (!Number.isSafeInteger(value.maxRuns) || value.maxRuns <= 0)) {
    throw new Error('Invalid maxRuns');
  }
  if (value.kind !== 'schedule') {
    if (value.schedule !== null) throw new Error('Only scheduled automations can have a schedule');
    return;
  }
  calculateNextRun(requireText(value.schedule ?? '', 'schedule'), 0, {
    timeZone: value.timezone,
    startAt: value.startAt,
    endAt: value.endAt,
  });
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
    projectId: row.project_id as string | null,
    model: row.model as string | null,
    thinking: row.thinking as AutomationThinkingLevel | null,
    enabled: Boolean(row.enabled),
    timezone: row.timezone as string,
    startAt: row.start_at as number | null,
    endAt: row.end_at as number | null,
    maxRuns: row.max_runs as number | null,
    runCount: row.run_count as number,
    misfirePolicy: row.misfire_policy as MisfirePolicy,
    lastRun: row.last_run as number | null,
    lastScheduledAt: row.last_scheduled_at as number | null,
    nextRun: row.next_run as number | null,
    completedAt: row.completed_at as number | null,
    deletedAt: row.deleted_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function workflow(row: Row): Workflow {
  const definition = parseJson(row.definition) as WorkflowDefinition | undefined;
  return {
    id: row.id as string,
    wakerId: row.waker_id as string,
    projectId: row.project_id as string | null,
    model: row.model as string | null,
    thinking: row.thinking as WorkflowThinkingLevel | null,
    name: row.name as string,
    description: row.description as string,
    script: row.script as string,
    definition: definition ?? null,
    validationErrors: (parseJson(row.validation_errors) as string[] | undefined) ?? [],
    status: row.status as WorkflowStatus,
    version: row.version as number,
    deletedAt: row.deleted_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function workflowVersion(row: Row): WorkflowVersion {
  return {
    workflowId: row.workflow_id as string,
    version: row.version as number,
    wakerId: row.waker_id_snapshot as string,
    projectId: row.project_id_snapshot as string | null,
    model: row.model_snapshot as string | null,
    thinking: row.thinking_snapshot as WorkflowThinkingLevel | null,
    name: row.name_snapshot as string,
    description: row.description_snapshot as string,
    definition: (parseJson(row.definition_snapshot) as WorkflowDefinition | undefined) ?? null,
    status: row.status_snapshot as WorkflowStatus,
    validationErrors: (parseJson(row.validation_errors) as string[] | undefined) ?? [],
    operation: row.operation as WorkflowVersionOperation,
    createdAt: row.created_at as number,
  };
}

function automationRun(row: Row): AutomationRun {
  return {
    id: row.id as string,
    automationId: row.automation_id as string,
    taskId: row.task_id as string,
    wakerId: row.waker_id as string,
    status: row.status as AutomationRunStatus,
    trigger: row.trigger as AutomationRunTrigger,
    scheduledFor: row.scheduled_for as number | null,
    nameSnapshot: row.name_snapshot as string,
    promptSnapshot: row.prompt_snapshot as string,
    projectId: row.project_id as string | null,
    sessionId: row.session_id as string | null,
    model: row.model as string | null,
    thinking: row.thinking as AutomationThinkingLevel | null,
    input: parseJson(row.input),
    output: parseJson(row.output),
    result: parseJson(row.result),
    usage: parseJson(row.usage),
    error: row.error as string | null,
    attempt: row.attempt as number,
    retryOfRunId: row.retry_of_run_id as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
  };
}

function workflowRun(row: Row): WorkflowRun {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    workflowId: row.workflow_id as string,
    workflowVersion: row.workflow_version as number,
    nameSnapshot: row.name_snapshot as string,
    descriptionSnapshot: row.description_snapshot as string,
    scriptSnapshot: row.script_snapshot as string,
    definitionSnapshot:
      (parseJson(row.definition_snapshot) as WorkflowDefinition | undefined) ?? null,
    wakerId: row.waker_id_snapshot as string,
    projectId: row.project_id_snapshot as string | null,
    model: row.model_snapshot as string | null,
    thinking: row.thinking_snapshot as WorkflowThinkingLevel | null,
    sessionId: row.session_id as string | null,
    parentRunId: row.parent_run_id as string | null,
    parentNodeId: row.parent_node_id as string | null,
    childRunId: row.child_run_id as string | null,
    depth: row.depth as number,
    attempt: row.attempt as number,
    retryOfRunId: row.retry_of_run_id as string | null,
    currentNodeId: row.current_node_id as string | null,
    context: (parseJson(row.context) as Record<string, unknown> | undefined) ?? {},
    wakeAt: row.wake_at as number | null,
    waitingActionId: row.waiting_action_id as string | null,
    status: row.status as WorkflowRunStatus,
    input: parseJson(row.input),
    output: parseJson(row.output),
    result: parseJson(row.result),
    usage: parseJson(row.usage),
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
    taskId: row.task_id as string | null,
    sessionId: row.session_id as string | null,
    kind: row.kind as HumanAction['kind'],
    title: row.title as string,
    prompt: row.prompt as string,
    status: row.status as HumanActionStatus,
    result: parseJson(row.result),
    version: row.version as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    resolvedAt: row.resolved_at as number | null,
    deletedAt: row.deleted_at as number | null,
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
    description: row.description as string,
    type: row.type as TaskType,
    origin: row.origin as TaskOrigin,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    position: row.position as number,
    version: row.version as number,
    wakerId: row.waker_id as string,
    projectId: row.project_id as string | null,
    sourceType: row.source_type as TaskSourceType,
    sourceId: row.source_id as string,
    source: row.source as string,
    runId: row.run_id as string | null,
    sessionId: row.session_id as string | null,
    parentTaskId: row.parent_task_id as string | null,
    result: row.result as string | null,
    error: row.error as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastActiveAt: row.last_active_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
    deletedAt: row.deleted_at as number | null,
  };
}

function taskEvent(row: Row): TaskEvent {
  return {
    id: row.id as number,
    taskId: row.task_id as string,
    wakerId: row.waker_id as string,
    sequence: row.sequence as number,
    type: row.type as string,
    status: row.status as TaskStatus | null,
    payload: parseJson(row.payload),
    createdAt: row.created_at as number,
  };
}

export interface WorkspaceStoreOptions {
  now?: () => number;
  migrationsDir?: string;
  resolveWorkflowReference?: (reference: WorkflowReference) => boolean;
}

export class WorkspaceStore {
  readonly db: Database.Database;
  private readonly now: () => number;
  private readonly resolveWorkflowReference?: (reference: WorkflowReference) => boolean;

  constructor(filename: string | Buffer = ':memory:', options: WorkspaceStoreOptions = {}) {
    this.db = new Database(filename);
    this.now = options.now ?? Date.now;
    this.resolveWorkflowReference = options.resolveWorkflowReference;
    this.db.pragma('foreign_keys = ON');
    this.migrate(
      options.migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), '../migrations'),
    );
    this.reconcileWorkflowDefinitions();
    this.reconcileAutomationSchedules();
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

  private reconcileWorkflowDefinitions(): void {
    const rows = this.db.prepare('SELECT * FROM workflows WHERE deleted_at IS NULL').all() as Row[];
    const update = this.db.prepare(
      'UPDATE workflows SET script=?,definition=?,validation_errors=?,status=? WHERE id=?',
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const result = validateWorkflowDefinition(row.definition ?? row.script);
        const errors = [...result.errors];
        if (row.waker_id === '__legacy_unbound__') {
          errors.unshift('Legacy workflow is not bound to a Waker');
        }
        const definition = result.definition
          ? serializeWorkflowDefinition(result.definition)
          : (row.script as string);
        update.run(
          definition,
          result.definition ? json(result.definition) : null,
          json(errors),
          errors.length ? 'error' : row.status,
          row.id,
        );
      }
    })();
  }

  private reconcileAutomationSchedules(): void {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM automations WHERE kind='schedule' AND enabled=1 AND next_run IS NULL
         AND completed_at IS NULL AND deleted_at IS NULL`,
      )
      .all();
    const update = this.db.prepare(
      'UPDATE automations SET next_run=?, completed_at=?, updated_at=? WHERE id=?',
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const value = automation(row as Row);
        const nextRun = calculateNextRun(value.schedule, now, {
          timeZone: value.timezone,
          startAt: value.startAt,
          endAt: value.endAt,
        });
        update.run(nextRun, nextRun === null ? now : null, now, value.id);
      }
    })();
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
    const count = (sql: string, ...parameters: unknown[]) =>
      (this.db.prepare(sql).get(...parameters) as Row).count as number;
    const automationTasksPreserved = count(
      `SELECT COUNT(DISTINCT runs.task_id) AS count
       FROM automation_runs AS runs JOIN tasks ON tasks.id=runs.task_id
       WHERE tasks.project_id=? AND runs.waker_id=?`,
      id,
      wakerId,
    );
    return {
      projectId: id,
      sessionContexts: count(
        'SELECT COUNT(*) AS count FROM session_contexts WHERE project_id=? AND waker_id=?',
        id,
        wakerId,
      ),
      tasks: count(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE project_id=? AND waker_id=? AND deleted_at IS NULL`,
        id,
        wakerId,
      ),
      tasksPreserved: count(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE project_id=? AND waker_id=? AND deleted_at IS NULL`,
        id,
        wakerId,
      ),
      automationDefinitions: count(
        `SELECT COUNT(*) AS count FROM automations
         WHERE project_id=? AND waker_id=? AND deleted_at IS NULL`,
        id,
        wakerId,
      ),
      automationRuns: count(
        `SELECT COUNT(DISTINCT runs.id) AS count
         FROM automation_runs AS runs LEFT JOIN tasks ON tasks.id=runs.task_id
         WHERE runs.waker_id=? AND (runs.project_id=? OR tasks.project_id=?)`,
        wakerId,
        id,
        id,
      ),
      automationTasksPreserved,
      workflowDefinitions: count(
        `SELECT COUNT(*) AS count FROM workflows
         WHERE project_id=? AND waker_id=? AND deleted_at IS NULL`,
        id,
        wakerId,
      ),
      workflowRuns: count(
        `SELECT COUNT(*) AS count FROM workflow_runs
         WHERE project_id_snapshot=? AND waker_id_snapshot=?`,
        id,
        wakerId,
      ),
    };
  }

  deleteProject(wakerId: string, id: string): boolean {
    return this.db.transaction(() => {
      if (!this.getOwnedProject(wakerId, id)) return false;
      const active = this.db
        .prepare(
          `SELECT 1 FROM automation_runs AS runs LEFT JOIN tasks ON tasks.id=runs.task_id
           WHERE runs.waker_id=? AND (runs.project_id=? OR tasks.project_id=?)
             AND runs.status IN ('queued','running') LIMIT 1`,
        )
        .get(wakerId, id, id);
      if (active) throw new Error('Project has an active automation run');
      const activeWorkflow = this.db
        .prepare(
          `SELECT 1 FROM workflow_runs
           WHERE waker_id_snapshot=? AND project_id_snapshot=?
             AND status IN ('queued','running','paused','waiting_input','waiting_child') LIMIT 1`,
        )
        .get(wakerId, id);
      if (activeWorkflow) throw new Error('Project has an active workflow run');
      // Board history outlives a project binding. Detach every Task and record the change.
      const projectTasks = this.db
        .prepare(
          `SELECT id FROM tasks
           WHERE waker_id=? AND project_id=? AND deleted_at IS NULL ORDER BY id`,
        )
        .all(wakerId, id) as Array<{ id: string }>;
      for (const boardTask of projectTasks) {
        this.db
          .prepare(
            `UPDATE tasks SET project_id=NULL,version=version+1,updated_at=?,last_active_at=?
             WHERE id=? AND waker_id=? AND project_id=?`,
          )
          .run(this.now(), this.now(), boardTask.id, wakerId, id);
        this.appendTaskEventUnsafe(wakerId, boardTask.id, 'project.detached', { projectId: id });
      }
      this.db
        .prepare(
          `UPDATE automations SET project_id=NULL, enabled=0, next_run=NULL, updated_at=?
           WHERE project_id=? AND waker_id=?`,
        )
        .run(this.now(), id, wakerId);
      this.db
        .prepare(
          `UPDATE workflows SET project_id=NULL,status='paused',updated_at=?
           WHERE project_id=? AND waker_id=? AND deleted_at IS NULL`,
        )
        .run(this.now(), id, wakerId);
      // A removed project must not leave a session able to reuse its old working directory.
      this.db
        .prepare('DELETE FROM session_contexts WHERE project_id=? AND waker_id=?')
        .run(id, wakerId);
      this.db.prepare('DELETE FROM projects WHERE id = ? AND waker_id = ?').run(id, wakerId);
      return true;
    })();
  }

  createAutomation(input: AutomationInput): Automation {
    requireText(input.wakerId, 'wakerId');
    requireText(input.name, 'name');
    requireText(input.prompt, 'prompt');
    requireEnum(input.kind, ['schedule', 'api', 'event'], 'automation kind');
    if (input.kind !== 'schedule' && input.schedule !== undefined && input.schedule !== null)
      throw new Error('Only scheduled automations can have a schedule');
    const id = input.id ?? randomUUID();
    const now = this.now();
    const schedule =
      input.kind === 'schedule' ? requireText(input.schedule ?? '', 'schedule') : null;
    const timezone = validateTimeZone(input.timezone ?? 'UTC');
    const startAt =
      input.startAt ??
      (input.kind === 'schedule' && schedule!.startsWith('interval:') ? now : null);
    const endAt = input.endAt ?? null;
    const maxRuns = input.maxRuns ?? null;
    const misfirePolicy = input.misfirePolicy ?? 'run_once';
    requireEnum(misfirePolicy, ['run_once', 'skip'], 'misfire policy');
    if (input.projectId && !this.getOwnedProject(input.wakerId, input.projectId)) {
      throw new Error('Project does not belong to Waker');
    }
    if (input.model !== null && input.model !== undefined) requireText(input.model, 'model');
    if (input.thinking !== null && input.thinking !== undefined)
      requireEnum(
        input.thinking,
        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        'thinking',
      );
    validateAutomationSchedule({
      kind: input.kind,
      schedule,
      timezone,
      startAt,
      endAt,
      maxRuns,
    });
    const nextRun =
      input.enabled === false || input.kind !== 'schedule'
        ? null
        : calculateNextRun(schedule, now, { timeZone: timezone, startAt, endAt });
    const completedAt =
      input.kind === 'schedule' && input.enabled !== false && nextRun === null ? now : null;
    this.db
      .prepare(
        `INSERT INTO automations
         (id, waker_id, name, kind, schedule, prompt, enabled, timezone, start_at, end_at,
          max_runs, run_count, misfire_policy, last_run, last_scheduled_at, next_run, completed_at,
          project_id, model, thinking, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.wakerId,
        input.name.trim(),
        input.kind,
        schedule,
        input.prompt.trim(),
        input.enabled === false ? 0 : 1,
        timezone,
        startAt,
        endAt,
        maxRuns,
        misfirePolicy,
        input.lastRun ?? null,
        nextRun,
        completedAt,
        input.projectId ?? null,
        input.model ?? null,
        input.thinking ?? null,
        now,
        now,
      );
    return this.getAutomation(input.wakerId, id)!;
  }

  listAutomations(wakerId: string): Automation[] {
    return this.db
      .prepare(
        'SELECT * FROM automations WHERE waker_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id',
      )
      .all(wakerId)
      .map((row) => automation(row as Row));
  }

  getAutomation(wakerId: string, id: string): Automation | undefined {
    const row = this.db
      .prepare('SELECT * FROM automations WHERE id = ? AND waker_id = ? AND deleted_at IS NULL')
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
    const now = this.now();
    requireText(value.name, 'name');
    requireText(value.prompt, 'prompt');
    requireEnum(value.kind, ['schedule', 'api', 'event'], 'automation kind');
    const timezone = validateTimeZone(value.timezone);
    const schedule =
      value.kind === 'schedule' ? requireText(value.schedule ?? '', 'schedule') : null;
    const startAt =
      value.kind === 'schedule' && schedule?.startsWith('interval:') && value.startAt === null
        ? now
        : value.startAt;
    const scheduleChanged =
      value.kind !== current.kind ||
      schedule !== current.schedule ||
      timezone !== current.timezone ||
      startAt !== current.startAt ||
      value.endAt !== current.endAt ||
      value.maxRuns !== current.maxRuns;
    validateAutomationSchedule({ ...value, schedule, timezone, startAt });
    if (value.projectId && !this.getOwnedProject(wakerId, value.projectId)) {
      throw new Error('Project does not belong to Waker');
    }
    if (value.model !== null) requireText(value.model, 'model');
    if (value.thinking !== null)
      requireEnum(
        value.thinking,
        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        'thinking',
      );
    const exhausted = value.maxRuns !== null && value.runCount >= value.maxRuns;
    const shouldRecalculate = scheduleChanged || value.enabled !== current.enabled;
    const nextRun =
      !value.enabled || value.kind !== 'schedule' || exhausted
        ? null
        : shouldRecalculate
          ? calculateNextRun(schedule, now, {
              timeZone: timezone,
              startAt,
              endAt: value.endAt,
            })
          : current.nextRun;
    const completedAt =
      value.enabled && value.kind === 'schedule' && nextRun === null
        ? (current.completedAt ?? now)
        : null;
    this.db
      .prepare(
        `UPDATE automations SET name=?, kind=?, schedule=?, prompt=?, enabled=?, timezone=?, start_at=?,
         end_at=?, max_runs=?, misfire_policy=?, last_run=?, next_run=?, completed_at=?,
         project_id=?, model=?, thinking=?, updated_at=?
         WHERE id=? AND waker_id=?`,
      )
      .run(
        value.name.trim(),
        value.kind,
        schedule,
        value.prompt.trim(),
        value.enabled ? 1 : 0,
        timezone,
        startAt,
        value.endAt,
        value.maxRuns,
        value.misfirePolicy,
        value.lastRun,
        nextRun,
        completedAt,
        value.projectId,
        value.model,
        value.thinking,
        now,
        id,
        wakerId,
      );
    return this.getAutomation(wakerId, id);
  }

  deleteAutomation(wakerId: string, id: string): boolean {
    return this.db.transaction(() => {
      if (!this.getAutomation(wakerId, id)) return false;
      this.requireNoActiveAutomationRun(id);
      const now = this.now();
      this.db
        .prepare(
          'UPDATE automations SET enabled=0, next_run=NULL, deleted_at=?, updated_at=? WHERE id=? AND waker_id=?',
        )
        .run(now, now, id, wakerId);
      return true;
    })();
  }

  getAutomationDeleteImpact(wakerId: string, id: string): AutomationDeleteImpact | undefined {
    if (!this.getAutomation(wakerId, id)) return undefined;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COUNT(DISTINCT task_id) AS tasks,
         COUNT(DISTINCT CASE WHEN session_id IS NOT NULL THEN session_id END) AS sessions
         FROM automation_runs WHERE automation_id=? AND waker_id=?`,
      )
      .get(id, wakerId) as Row;
    return {
      automationId: id,
      runs: row.runs as number,
      tasks: row.tasks as number,
      sessions: row.sessions as number,
    };
  }

  deleteAutomationsForWaker(wakerId: string): number {
    return this.db.transaction(() => {
      const values = this.listAutomations(wakerId);
      for (const value of values) this.requireNoActiveAutomationRun(value.id);
      const now = this.now();
      return this.db
        .prepare(
          `UPDATE automations SET enabled=0, next_run=NULL, deleted_at=?, updated_at=?
           WHERE waker_id=? AND deleted_at IS NULL`,
        )
        .run(now, now, wakerId).changes;
    })();
  }

  pauseAutomation(wakerId: string, id: string): Automation | undefined {
    return this.updateAutomation(wakerId, id, { enabled: false });
  }

  resumeAutomation(wakerId: string, id: string): Automation | undefined {
    return this.updateAutomation(wakerId, id, { enabled: true });
  }

  runAutomation(wakerId: string, id: string, input?: unknown): Task {
    const run = this.enqueueAutomationRun(wakerId, id, { trigger: 'manual', input });
    return this.getTask(wakerId, run.taskId)!;
  }

  enqueueAutomationRun(
    wakerId: string,
    id: string,
    input: EnqueueAutomationRunInput,
  ): AutomationRun {
    if (input.trigger !== 'manual') {
      throw new Error('Scheduled runs must be claimed by the scheduler');
    }
    return this.db.transaction(() => {
      const value = this.requireAutomationForRun(wakerId, id);
      this.requireNoActiveAutomationRun(id);
      const run = this.insertAutomationRun(value, input, null);
      const now = this.now();
      this.db
        .prepare('UPDATE automations SET last_run=?, updated_at=? WHERE id=?')
        .run(now, now, id);
      return run;
    })();
  }

  claimDueAutomation(
    wakerId: string,
    id: string,
    observedAt = this.now(),
    input?: unknown,
  ): AutomationRun | undefined {
    return this.db.transaction(() => {
      const value = this.getAutomation(wakerId, id);
      if (
        !value ||
        !value.enabled ||
        value.kind !== 'schedule' ||
        value.nextRun === null ||
        value.nextRun > observedAt
      ) {
        return undefined;
      }
      if (this.hasActiveAutomationRun(id)) return undefined;
      if (value.maxRuns !== null && value.runCount >= value.maxRuns) {
        this.db
          .prepare('UPDATE automations SET next_run=NULL, completed_at=?, updated_at=? WHERE id=?')
          .run(observedAt, observedAt, id);
        return undefined;
      }

      const scheduledFor = value.nextRun;
      // A normal 30s poll is on time; only a slot delayed by over a minute is a misfire.
      if (value.misfirePolicy === 'skip' && observedAt - scheduledFor > automationMisfireGraceMs) {
        const queued = this.insertAutomationRun(
          value,
          { trigger: 'scheduled', input },
          scheduledFor,
        );
        const skipped = this.finishAutomationRun(
          wakerId,
          queued.id,
          'skipped',
          undefined,
          'Scheduled slot skipped by misfire policy',
        );
        const nextRun = calculateNextRun(value.schedule, observedAt, {
          timeZone: value.timezone,
          startAt: value.startAt,
          endAt: value.endAt,
        });
        this.db
          .prepare(
            `UPDATE automations SET last_scheduled_at=?, next_run=?, completed_at=?, updated_at=?
             WHERE id=?`,
          )
          .run(scheduledFor, nextRun, nextRun === null ? observedAt : null, observedAt, id);
        return skipped;
      }
      const run = this.insertAutomationRun(value, { trigger: 'scheduled', input }, scheduledFor);
      const runCount = value.runCount + 1;
      const nextRun =
        value.maxRuns !== null && runCount >= value.maxRuns
          ? null
          : calculateNextRun(value.schedule, observedAt, {
              timeZone: value.timezone,
              startAt: value.startAt,
              endAt: value.endAt,
            });
      this.db
        .prepare(
          `UPDATE automations SET run_count=?, last_run=?, last_scheduled_at=?, next_run=?,
           completed_at=?, updated_at=? WHERE id=?`,
        )
        .run(
          runCount,
          observedAt,
          scheduledFor,
          nextRun,
          nextRun === null ? observedAt : null,
          observedAt,
          id,
        );
      return run;
    })();
  }

  retryAutomationRun(wakerId: string, runId: string): AutomationRun {
    return this.db.transaction(() => {
      const source = this.requireAutomationRun(wakerId, runId, ['failed', 'cancelled', 'skipped']);
      const value = this.requireAutomationForRun(wakerId, source.automationId);
      this.requireNoActiveAutomationRun(value.id);
      return this.insertAutomationRun(
        value,
        {
          trigger: 'manual',
          input: source.input,
          projectId: source.projectId,
          model: source.model,
          thinking: source.thinking,
        },
        null,
        {
          name: source.nameSnapshot,
          prompt: source.promptSnapshot,
          attempt: source.attempt + 1,
          retryOfRunId: source.id,
        },
      );
    })();
  }

  private requireAutomationForRun(wakerId: string, id: string): Automation {
    const value = this.getAutomation(wakerId, id);
    if (!value) throw new Error('Automation not found');
    return value;
  }

  private hasActiveAutomationRun(id: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM automation_runs WHERE automation_id=? AND status IN ('queued','running')",
        )
        .get(id),
    );
  }

  private requireNoActiveAutomationRun(id: string): void {
    if (this.hasActiveAutomationRun(id)) throw new Error('Automation already has an active run');
  }

  private insertAutomationRun(
    value: Automation,
    input: EnqueueAutomationRunInput,
    scheduledFor: number | null,
    snapshot: {
      name?: string;
      prompt?: string;
      attempt?: number;
      retryOfRunId?: string | null;
    } = {},
  ): AutomationRun {
    const now = this.now();
    const projectId = input.projectId === undefined ? value.projectId : input.projectId;
    const model = input.model === undefined ? value.model : input.model;
    const thinking = input.thinking === undefined ? value.thinking : input.thinking;
    const runId = randomUUID();
    const taskValue = this.createDerivedTask({
      title: snapshot.name ?? value.name,
      type: 'automation',
      status: 'queued',
      wakerId: value.wakerId,
      projectId,
      sourceType: 'automation',
      sourceId: runId,
      source: `automation:${value.id}`,
      runId,
    });
    this.db
      .prepare(
        `INSERT INTO automation_runs
         (id,automation_id,task_id,waker_id,status,trigger,scheduled_for,name_snapshot,
          prompt_snapshot,project_id,model,thinking,input,attempt,retry_of_run_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        value.id,
        taskValue.id,
        value.wakerId,
        'queued',
        input.trigger,
        scheduledFor,
        snapshot.name ?? value.name,
        snapshot.prompt ?? value.prompt,
        projectId,
        model,
        thinking,
        json(input.input),
        snapshot.attempt ?? 1,
        snapshot.retryOfRunId ?? null,
        now,
        now,
      );
    return this.getAutomationRun(value.wakerId, runId)!;
  }

  listAutomationRuns(
    wakerId: string,
    automationId?: string,
    page: { limit?: number; offset?: number } = {},
  ): AutomationRun[] {
    const limit = page.limit ?? 100;
    const offset = page.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid limit');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const sql = automationId
      ? `SELECT * FROM automation_runs WHERE waker_id = ? AND automation_id = ?
         ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
      : `SELECT * FROM automation_runs WHERE waker_id = ?
         ORDER BY created_at DESC, id LIMIT ? OFFSET ?`;
    const rows = automationId
      ? this.db.prepare(sql).all(wakerId, automationId, limit, offset)
      : this.db.prepare(sql).all(wakerId, limit, offset);
    return rows.map((row) => automationRun(row as Row));
  }

  countAutomationRuns(wakerId: string, automationId?: string): number {
    const sql = automationId
      ? 'SELECT COUNT(*) AS count FROM automation_runs WHERE waker_id=? AND automation_id=?'
      : 'SELECT COUNT(*) AS count FROM automation_runs WHERE waker_id=?';
    const row = automationId
      ? this.db.prepare(sql).get(wakerId, automationId)
      : this.db.prepare(sql).get(wakerId);
    return (row as Row).count as number;
  }

  listRecoverableAutomationRuns(wakerId: string): AutomationRun[] {
    return this.db
      .prepare(
        `SELECT * FROM automation_runs WHERE waker_id=? AND status IN ('queued','running')
         ORDER BY created_at, id`,
      )
      .all(wakerId)
      .map((row) => automationRun(row as Row));
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

  attachAutomationRunSession(wakerId: string, runId: string, sessionId: string): AutomationRun {
    return this.db.transaction(() => {
      const run = this.requireAutomationRun(wakerId, runId, ['queued', 'running']);
      const value = requireText(sessionId, 'sessionId');
      if (run.sessionId && run.sessionId !== value)
        throw new Error('Automation run session is immutable');
      if (!run.sessionId) {
        this.db
          .prepare('UPDATE automation_runs SET session_id=?, updated_at=? WHERE id=?')
          .run(value, this.now(), runId);
        this.updateDerivedTask(
          wakerId,
          run.taskId,
          { sessionId: value },
          'automation.session_linked',
          { runId, sessionId: value },
        );
      }
      return this.getAutomationRun(wakerId, runId)!;
    })();
  }

  clearAutomationRunSession(wakerId: string, runId: string, sessionId: string): AutomationRun {
    return this.db.transaction(() => {
      const run = this.getAutomationRun(wakerId, runId);
      if (!run) throw new Error('Automation run not found');
      if (run.sessionId !== requireText(sessionId, 'sessionId')) {
        throw new Error('Automation run session does not match');
      }
      this.db
        .prepare(
          'UPDATE automation_runs SET session_id=NULL, updated_at=? WHERE id=? AND waker_id=?',
        )
        .run(this.now(), runId, wakerId);
      this.updateDerivedTask(
        wakerId,
        run.taskId,
        { sessionId: null },
        'automation.session_unlinked',
        { runId },
      );
      return this.getAutomationRun(wakerId, runId)!;
    })();
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
      this.updateDerivedTask(
        wakerId,
        run.taskId,
        { status: 'running', startedAt: now },
        'automation.started',
        { runId },
      );
      return this.getAutomationRun(wakerId, runId)!;
    })();
  }

  completeAutomationRun(
    wakerId: string,
    runId: string,
    result?: unknown,
    usage?: unknown,
  ): AutomationRun {
    return this.finishAutomationRun(wakerId, runId, 'succeeded', result, undefined, usage);
  }

  failAutomationRun(wakerId: string, runId: string, error: string): AutomationRun {
    requireText(error, 'error');
    return this.finishAutomationRun(wakerId, runId, 'failed', undefined, error);
  }

  cancelAutomationRun(wakerId: string, runId: string): AutomationRun {
    return this.finishAutomationRun(wakerId, runId, 'cancelled');
  }

  skipAutomationRun(wakerId: string, runId: string, reason: string): AutomationRun {
    requireText(reason, 'reason');
    return this.finishAutomationRun(wakerId, runId, 'skipped', undefined, reason);
  }

  private requireAutomationRun(
    wakerId: string,
    runId: string,
    allowed: readonly AutomationRunStatus[],
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
    status: 'succeeded' | 'failed' | 'cancelled' | 'skipped',
    result?: unknown,
    error?: string,
    usage?: unknown,
  ): AutomationRun {
    return this.db.transaction(() => {
      const allowed: AutomationRunStatus[] =
        status === 'succeeded' ? ['running'] : ['queued', 'running'];
      const run = this.requireAutomationRun(wakerId, runId, allowed);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE automation_runs SET status=?, output=?, result=?, usage=?, error=?,
           completed_at=?, updated_at=? WHERE id=?`,
        )
        .run(status, json(result), json(result), json(usage), error ?? null, now, now, runId);
      const taskStatus: TaskStatus =
        status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled';
      this.updateDerivedTask(
        wakerId,
        run.taskId,
        {
          status: taskStatus,
          result: json(result),
          error: error ?? null,
          completedAt: now,
        },
        `automation.${status}`,
        { runId, status },
      );
      return this.getAutomationRun(wakerId, runId)!;
    })();
  }

  createWorkflow(input: WorkflowCreateInput): Workflow {
    const wakerId = requireText(input.wakerId, 'wakerId');
    const name = requireText(input.name, 'name');
    const status = input.status ?? 'draft';
    requireEnum(status, ['draft', 'active', 'paused'], 'workflow status');
    const model = input.model ? requireText(input.model, 'model') : null;
    const thinking = input.thinking ?? null;
    if (thinking) requireEnum(thinking, workflowThinkingLevels, 'workflow thinking');
    const id = input.id ?? randomUUID();
    const projectId = input.projectId ?? null;
    this.assertWorkflowOwnerReferences(wakerId, projectId);
    const definition = this.normalizeOwnedWorkflowDefinition(
      input.definition ?? input.script,
      wakerId,
      id,
    );
    const script = serializeWorkflowDefinition(definition);
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workflows
           (id,waker_id,project_id,model,thinking,name,description,script,definition,validation_errors,status,version,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          id,
          wakerId,
          projectId,
          model,
          thinking,
          name,
          input.description ?? '',
          script,
          json(definition),
          '[]',
          status,
          now,
          now,
        );
      this.insertWorkflowVersion(this.requireOwnedWorkflow(wakerId, id, true), 'create');
    })();
    return this.getWorkflow(wakerId, id)!;
  }

  validateWorkflow(
    wakerId: string,
    source: unknown,
    input: { workflowId?: string; projectId?: string | null } = {},
  ): WorkflowDefinitionValidation {
    try {
      const owner = requireText(wakerId, 'wakerId');
      this.assertWorkflowOwnerReferences(owner, input.projectId ?? null);
      const definition = this.normalizeOwnedWorkflowDefinition(
        source,
        owner,
        input.workflowId ?? '__workflow_validation__',
      );
      return {
        valid: true,
        definition,
        script: serializeWorkflowDefinition(definition),
        errors: [],
      };
    } catch (error) {
      return {
        valid: false,
        errors:
          error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)
            ? (error.errors as string[])
            : [error instanceof Error ? error.message : 'Invalid workflow definition'],
      };
    }
  }

  listWorkflows(wakerId: string): Workflow[] {
    return this.db
      .prepare(
        'SELECT * FROM workflows WHERE waker_id=? AND deleted_at IS NULL ORDER BY updated_at DESC, id',
      )
      .all(requireText(wakerId, 'wakerId'))
      .map((row) => workflow(row as Row));
  }

  getWorkflow(wakerId: string, id: string): Workflow | undefined {
    const row = this.db
      .prepare('SELECT * FROM workflows WHERE waker_id=? AND id=? AND deleted_at IS NULL')
      .get(requireText(wakerId, 'wakerId'), requireText(id, 'workflowId'));
    return row ? workflow(row as Row) : undefined;
  }

  previewWorkflowUpdate(
    wakerId: string,
    id: string,
    patch: WorkflowUpdateInput,
  ): WorkflowMutationPreview | undefined {
    const current = this.getWorkflow(wakerId, id);
    if (!current) return undefined;
    this.assertWorkflowVersion(current, patch.expectedVersion);
    const proposed = this.workflowUpdateValue(current, patch);
    return {
      applied: false,
      workflow: current,
      diff: unifiedLineDiff(
        workflowSnapshotText(current),
        workflowSnapshotText(proposed),
        `v${current.version}`,
        `v${current.version + 1}`,
      ),
    };
  }

  updateWorkflow(wakerId: string, id: string, patch: WorkflowUpdateInput): Workflow | undefined {
    return this.applyWorkflowUpdate(wakerId, id, patch, 'update');
  }

  listWorkflowVersions(
    wakerId: string,
    workflowId: string,
    limit = 100,
    offset = 0,
  ): WorkflowVersion[] {
    if (!this.getWorkflow(wakerId, workflowId)) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error('limit is invalid');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset is invalid');
    return this.db
      .prepare(
        'SELECT * FROM workflow_versions WHERE workflow_id=? ORDER BY version DESC LIMIT ? OFFSET ?',
      )
      .all(workflowId, limit, offset)
      .map((row) => workflowVersion(row as Row));
  }

  countWorkflowVersions(wakerId: string, workflowId: string): number {
    if (!this.getWorkflow(wakerId, workflowId)) return 0;
    return (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM workflow_versions WHERE workflow_id=?')
        .get(workflowId) as { count: number }
    ).count;
  }

  getWorkflowVersion(
    wakerId: string,
    workflowId: string,
    version: number,
  ): WorkflowVersion | undefined {
    if (!this.getWorkflow(wakerId, workflowId)) return undefined;
    const row = this.db
      .prepare('SELECT * FROM workflow_versions WHERE workflow_id=? AND version=?')
      .get(workflowId, version);
    return row ? workflowVersion(row as Row) : undefined;
  }

  diffWorkflowVersions(
    wakerId: string,
    workflowId: string,
    fromVersion: number,
    toVersion: number,
  ): string | undefined {
    const from = this.getWorkflowVersion(wakerId, workflowId, fromVersion);
    const to = this.getWorkflowVersion(wakerId, workflowId, toVersion);
    if (!from || !to) return undefined;
    return unifiedLineDiff(
      workflowVersionSnapshotText(from),
      workflowVersionSnapshotText(to),
      `v${fromVersion}`,
      `v${toVersion}`,
    );
  }

  rollbackWorkflow(
    wakerId: string,
    workflowId: string,
    input: { targetVersion: number; expectedVersion: number; apply?: boolean },
  ): WorkflowMutationPreview | undefined {
    const current = this.getWorkflow(wakerId, workflowId);
    const target = this.getWorkflowVersion(wakerId, workflowId, input.targetVersion);
    if (!current || !target) return undefined;
    this.assertWorkflowVersion(current, input.expectedVersion);
    if (!target.definition) throw new Error('Legacy workflow version cannot be restored');
    const patch: WorkflowUpdateInput = {
      expectedVersion: input.expectedVersion,
      projectId: target.projectId,
      model: target.model,
      thinking: target.thinking,
      name: target.name,
      description: target.description,
      definition: target.definition,
      status: target.status === 'error' ? 'draft' : target.status,
    };
    const preview = this.previewWorkflowUpdate(wakerId, workflowId, patch)!;
    if (input.apply !== true) return preview;
    const applied = this.applyWorkflowUpdate(wakerId, workflowId, patch, 'rollback')!;
    return { applied: true, workflow: applied, diff: preview.diff };
  }

  getWorkflowDeleteImpact(wakerId: string, workflowId: string): WorkflowDeleteImpact | undefined {
    const value = this.getWorkflow(wakerId, workflowId);
    if (!value) return undefined;
    const count = (sql: string): number =>
      (this.db.prepare(sql).get(workflowId) as { count: number }).count;
    const currentReferences = this.listWorkflows(wakerId)
      .filter(
        (workflow) =>
          workflow.id !== workflowId &&
          workflow.definition?.nodes.some(
            (node) => node.kind === 'call_workflow' && node.workflowId === workflowId,
          ),
      )
      .map((workflow) => workflow.id);
    const snapshotReferences = (
      this.db
        .prepare(
          `SELECT workflow_id,definition_snapshot FROM workflow_runs
           WHERE waker_id_snapshot=?
             AND status IN ('queued','running','paused','waiting_input','waiting_child')`,
        )
        .all(wakerId) as Array<{ workflow_id: string; definition_snapshot: string | null }>
    )
      .filter(({ workflow_id: sourceId, definition_snapshot: snapshot }) => {
        if (sourceId === workflowId || !snapshot) return false;
        const definition = parseJson(snapshot) as WorkflowDefinition | undefined;
        return definition?.nodes.some(
          (node) => node.kind === 'call_workflow' && node.workflowId === workflowId,
        );
      })
      .map(({ workflow_id: sourceId }) => sourceId);
    const referencedBy = [...new Set([...currentReferences, ...snapshotReferences])].sort();
    return {
      workflowId,
      versions: count('SELECT COUNT(*) AS count FROM workflow_versions WHERE workflow_id=?'),
      runs: count('SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id=?'),
      activeRuns: count(
        "SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id=? AND status IN ('queued','running','paused','waiting_input','waiting_child')",
      ),
      referencedBy,
    };
  }

  deleteWorkflow(wakerId: string, workflowId: string, expectedVersion: number): boolean {
    return this.db.transaction(() => {
      const current = this.getWorkflow(wakerId, workflowId);
      if (!current) return false;
      this.assertWorkflowVersion(current, expectedVersion);
      const impact = this.getWorkflowDeleteImpact(wakerId, workflowId)!;
      if (impact.activeRuns) throw new Error('Cannot delete a workflow with active runs');
      if (impact.referencedBy.length) {
        throw new Error(`Workflow is referenced by: ${impact.referencedBy.join(', ')}`);
      }
      return (
        this.db
          .prepare(
            'UPDATE workflows SET deleted_at=?,status=?,updated_at=? WHERE waker_id=? AND id=? AND version=? AND deleted_at IS NULL',
          )
          .run(this.now(), 'paused', this.now(), wakerId, workflowId, expectedVersion).changes > 0
      );
    })();
  }

  deleteWorkflowsForWaker(wakerId: string): number {
    return this.db.transaction(() => {
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM workflow_runs
           WHERE waker_id_snapshot=? AND status IN ('queued','running','paused','waiting_input','waiting_child')`,
        )
        .get(wakerId) as { count: number };
      if (active.count) throw new Error('Cannot delete Waker workflows with active runs');
      const now = this.now();
      return this.db
        .prepare(
          `UPDATE workflows SET deleted_at=?,status='paused',updated_at=?
           WHERE waker_id=? AND deleted_at IS NULL`,
        )
        .run(now, now, requireText(wakerId, 'wakerId')).changes;
    })();
  }

  private applyWorkflowUpdate(
    wakerId: string,
    workflowId: string,
    patch: WorkflowUpdateInput,
    operation: 'update' | 'rollback',
  ): Workflow | undefined {
    return this.db.transaction(() => {
      const current = this.getWorkflow(wakerId, workflowId);
      if (!current) return undefined;
      this.assertWorkflowVersion(current, patch.expectedVersion);
      const next = this.workflowUpdateValue(current, patch);
      const result = this.db
        .prepare(
          `UPDATE workflows
           SET project_id=?,model=?,thinking=?,name=?,description=?,script=?,definition=?,validation_errors='[]',
               status=?,version=version+1,updated_at=?
           WHERE waker_id=? AND id=? AND version=? AND deleted_at IS NULL`,
        )
        .run(
          next.projectId,
          next.model,
          next.thinking,
          next.name,
          next.description,
          next.script,
          json(next.definition),
          next.status,
          next.updatedAt,
          wakerId,
          workflowId,
          patch.expectedVersion,
        );
      if (result.changes !== 1) {
        const fresh = this.requireOwnedWorkflow(wakerId, workflowId);
        throw new WorkflowConflictError(patch.expectedVersion, fresh.version);
      }
      const updated = this.requireOwnedWorkflow(wakerId, workflowId);
      this.insertWorkflowVersion(updated, operation);
      return updated;
    })();
  }

  private workflowUpdateValue(current: Workflow, patch: WorkflowUpdateInput): Workflow {
    if (!Number.isSafeInteger(patch.expectedVersion) || patch.expectedVersion < 1) {
      throw new Error('expectedVersion must be a positive integer');
    }
    if (patch.definition !== undefined && patch.script !== undefined) {
      throw new Error('Provide definition or script, not both');
    }
    if (
      patch.name === undefined &&
      patch.description === undefined &&
      patch.projectId === undefined &&
      patch.model === undefined &&
      patch.thinking === undefined &&
      patch.definition === undefined &&
      patch.script === undefined &&
      patch.status === undefined
    ) {
      throw new Error('At least one workflow field must be updated');
    }
    const projectId = patch.projectId === undefined ? current.projectId : patch.projectId;
    const model = patch.model === undefined ? current.model : patch.model;
    const thinking = patch.thinking === undefined ? current.thinking : patch.thinking;
    if (thinking) requireEnum(thinking, workflowThinkingLevels, 'workflow thinking');
    this.assertWorkflowOwnerReferences(current.wakerId, projectId);
    const source = patch.definition ?? patch.script ?? current.definition;
    const definition = this.normalizeOwnedWorkflowDefinition(source, current.wakerId, current.id);
    const status =
      patch.status ?? (current.status === 'error' ? ('draft' as const) : current.status);
    requireEnum(status, ['draft', 'active', 'paused'], 'workflow status');
    const now = this.now();
    return {
      ...current,
      projectId,
      model: model ? requireText(model, 'model') : null,
      thinking,
      name: patch.name === undefined ? current.name : requireText(patch.name, 'name'),
      description: patch.description ?? current.description,
      definition,
      script: serializeWorkflowDefinition(definition),
      validationErrors: [],
      status,
      version: current.version + 1,
      updatedAt: now,
    };
  }

  private assertWorkflowOwnerReferences(wakerId: string, projectId: string | null): void {
    if (
      this.resolveWorkflowReference &&
      !this.resolveWorkflowReference({ kind: 'waker', id: wakerId })
    ) {
      throw new Error(`Workflow owner Waker does not exist: ${wakerId}`);
    }
    if (projectId && !this.getOwnedProject(wakerId, projectId)) {
      throw new Error(`Workflow owner project does not exist: ${projectId}`);
    }
    if (
      projectId &&
      this.resolveWorkflowReference &&
      !this.resolveWorkflowReference({ kind: 'project', id: projectId })
    ) {
      throw new Error(`Workflow owner project does not exist: ${projectId}`);
    }
  }

  private normalizeOwnedWorkflowDefinition(
    source: unknown,
    wakerId: string,
    workflowId: string,
  ): WorkflowDefinition {
    if (source === undefined || source === null) throw new Error('Workflow definition is required');
    const definition = normalizeWorkflowDefinition(source, {
      resolveReference: (reference) => {
        const owned =
          reference.kind === 'waker'
            ? reference.id === wakerId
            : reference.kind === 'project'
              ? Boolean(this.getOwnedProject(wakerId, reference.id))
              : reference.id !== workflowId && Boolean(this.getWorkflow(wakerId, reference.id));
        return owned && (this.resolveWorkflowReference?.(reference) ?? true);
      },
    });
    this.assertWorkflowCallGraph(wakerId, workflowId, definition);
    return definition;
  }

  private assertWorkflowCallGraph(
    wakerId: string,
    workflowId: string,
    candidate: WorkflowDefinition,
  ): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Workflow call cycle detected at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      const definition = id === workflowId ? candidate : this.getWorkflow(wakerId, id)?.definition;
      for (const node of definition?.nodes ?? []) {
        if (node.kind === 'call_workflow') visit(node.workflowId);
      }
      visiting.delete(id);
      visited.add(id);
    };
    visit(workflowId);
  }

  private insertWorkflowVersion(value: Workflow, operation: WorkflowVersionOperation): void {
    this.db
      .prepare(
        `INSERT INTO workflow_versions
         (workflow_id,version,waker_id_snapshot,project_id_snapshot,model_snapshot,thinking_snapshot,name_snapshot,
          description_snapshot,definition_snapshot,status_snapshot,validation_errors,operation,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        value.id,
        value.version,
        value.wakerId,
        value.projectId,
        value.model,
        value.thinking,
        value.name,
        value.description,
        json(value.definition),
        value.status,
        json(value.validationErrors),
        operation,
        value.updatedAt,
      );
  }

  private requireOwnedWorkflow(
    wakerId: string,
    workflowId: string,
    includeDeleted = false,
  ): Workflow {
    const row = this.db
      .prepare(
        `SELECT * FROM workflows WHERE waker_id=? AND id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
      )
      .get(wakerId, workflowId);
    if (!row) throw new Error('Workflow not found');
    return workflow(row as Row);
  }

  private assertWorkflowVersion(value: Workflow, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error('expectedVersion must be a positive integer');
    }
    if (value.version !== expectedVersion) {
      throw new WorkflowConflictError(expectedVersion, value.version);
    }
  }

  runWorkflow(
    wakerId: string,
    workflowId: string,
    input?: unknown,
    options: WorkflowRunOptions = {},
  ): WorkflowRun {
    return this.db.transaction(() => {
      const value = this.getWorkflow(wakerId, workflowId);
      if (!value) throw new Error('Workflow not found');
      if (value.status !== 'active') throw new Error('Workflow is not active');
      if (!value.definition) throw new Error('Workflow definition is invalid');
      const depth = options.depth ?? 0;
      if (!Number.isSafeInteger(depth) || depth < 0 || depth > 8) {
        throw new Error('Workflow call depth must be between 0 and 8');
      }
      if (options.parentRunId) {
        const parent = this.getWorkflowRun(wakerId, options.parentRunId);
        if (!parent || parent.status !== 'running')
          throw new Error('Parent workflow run is not active');
        if (!options.parentNodeId) throw new Error('parentNodeId is required for a child workflow');
        if (depth !== parent.depth + 1) throw new Error('Invalid child workflow depth');
      } else if (depth !== 0 || options.parentNodeId) {
        throw new Error('Top-level workflow runs must have depth 0');
      }
      const id = randomUUID();
      const now = this.now();
      const parentTaskId = options.parentRunId
        ? (this.getWorkflowRun(wakerId, options.parentRunId)?.taskId ?? null)
        : null;
      const taskValue = this.createDerivedTask({
        title: value.name,
        description: value.description,
        type: 'workflow',
        wakerId: value.wakerId,
        projectId: value.projectId,
        sourceType: 'workflow',
        sourceId: id,
        source: `workflow:${workflowId}`,
        runId: id,
        parentTaskId,
      });
      try {
        this.db
          .prepare(
            `INSERT INTO workflow_runs
         (id,task_id,workflow_id,workflow_version,name_snapshot,description_snapshot,script_snapshot,
          definition_snapshot,waker_id_snapshot,project_id_snapshot,model_snapshot,thinking_snapshot,
          parent_run_id,parent_node_id,depth,attempt,retry_of_run_id,current_node_id,context,
          status,input,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            taskValue.id,
            workflowId,
            value.version,
            value.name,
            value.description,
            value.script,
            json(value.definition),
            value.wakerId,
            value.projectId,
            value.model,
            value.thinking,
            options.parentRunId ?? null,
            options.parentNodeId ?? null,
            depth,
            options.attempt ?? 1,
            options.retryOfRunId ?? null,
            value.definition.start,
            json({ input }),
            'queued',
            json(input),
            now,
            now,
          );
      } catch (error) {
        if (
          error instanceof Error &&
          /workflow_runs_active_idx|UNIQUE constraint failed/.test(error.message)
        ) {
          throw new Error('Workflow already has an active run', { cause: error });
        }
        throw error;
      }
      this.appendWorkflowRunEventUnsafe(wakerId, id, 'queued', { input });
      return this.getWorkflowRun(wakerId, id)!;
    })();
  }

  listWorkflowRuns(wakerId: string, workflowId?: string, limit = 100, offset = 0): WorkflowRun[] {
    requireText(wakerId, 'wakerId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error('limit is invalid');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset is invalid');
    const rows = workflowId
      ? this.db
          .prepare(
            `SELECT * FROM workflow_runs WHERE waker_id_snapshot=? AND workflow_id=?
             ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
          )
          .all(wakerId, workflowId, limit, offset)
      : this.db
          .prepare(
            `SELECT * FROM workflow_runs WHERE waker_id_snapshot=?
             ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
          )
          .all(wakerId, limit, offset);
    return rows.map((row) => workflowRun(row as Row));
  }

  countWorkflowRuns(wakerId: string, workflowId?: string): number {
    requireText(wakerId, 'wakerId');
    const row = workflowId
      ? this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM workflow_runs WHERE waker_id_snapshot=? AND workflow_id=?',
          )
          .get(wakerId, workflowId)
      : this.db
          .prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE waker_id_snapshot=?')
          .get(wakerId);
    return (row as { count: number }).count;
  }

  listRecoverableWorkflowRuns(wakerId: string): WorkflowRun[] {
    return this.db
      .prepare(
        `SELECT * FROM workflow_runs
         WHERE waker_id_snapshot=? AND status IN ('queued','running','paused','waiting_input','waiting_child')
         ORDER BY created_at,id`,
      )
      .all(requireText(wakerId, 'wakerId'))
      .map((row) => workflowRun(row as Row));
  }

  getWorkflowRun(wakerId: string, runId: string): WorkflowRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM workflow_runs WHERE waker_id_snapshot=? AND id=?')
      .get(requireText(wakerId, 'wakerId'), requireText(runId, 'runId'));
    return row ? workflowRun(row as Row) : undefined;
  }

  startWorkflowRun(wakerId: string, runId: string): WorkflowRun {
    return this.db.transaction(() => {
      const now = this.now();
      const result = this.db
        .prepare(
          `UPDATE workflow_runs SET status='running',started_at=?,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='queued'`,
        )
        .run(now, now, wakerId, runId);
      const owned = this.getWorkflowRun(wakerId, runId);
      if (result.changes !== 1 || owned?.status !== 'running') {
        throw new Error(`Invalid workflow run transition from ${owned?.status ?? 'missing'}`);
      }
      this.updateDerivedTask(
        wakerId,
        owned.taskId,
        { status: 'running', startedAt: now },
        'workflow.started',
        { runId },
      );
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'started');
      return owned;
    })();
  }

  attachWorkflowRunSession(wakerId: string, runId: string, sessionId: string): WorkflowRun {
    return this.db.transaction(() => {
      const value = requireText(sessionId, 'sessionId');
      const run = this.requireWorkflowRun(wakerId, runId, ['running']);
      const result = this.db
        .prepare(
          `UPDATE workflow_runs SET session_id=?,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND session_id IS NULL AND status='running'`,
        )
        .run(value, this.now(), wakerId, runId);
      if (result.changes !== 1) throw new Error('Workflow run cannot accept a Session');
      this.updateDerivedTask(wakerId, run.taskId, { sessionId: value }, 'workflow.session_linked', {
        runId,
        sessionId: value,
      });
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  clearWorkflowRunSession(wakerId: string, runId: string, sessionId: string): WorkflowRun {
    return this.db.transaction(() => {
      const run = this.getWorkflowRun(wakerId, runId);
      if (!run) throw new Error('Workflow run not found');
      const result = this.db
        .prepare(
          'UPDATE workflow_runs SET session_id=NULL,updated_at=? WHERE waker_id_snapshot=? AND id=? AND session_id=?',
        )
        .run(this.now(), wakerId, runId, sessionId);
      if (result.changes !== 1) throw new Error('Workflow Session link changed');
      this.updateDerivedTask(
        wakerId,
        run.taskId,
        { sessionId: null },
        'workflow.session_unlinked',
        { runId },
      );
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  addWorkflowRunUsage(
    wakerId: string,
    runId: string,
    usage: { input: number; output: number; total: number },
  ): WorkflowRun {
    for (const value of [usage.input, usage.output, usage.total]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Workflow usage is invalid');
    }
    return this.db.transaction(() => {
      const run = this.requireWorkflowRun(wakerId, runId, ['running']);
      const current = workflowUsage(run.usage);
      this.db
        .prepare('UPDATE workflow_runs SET usage=?,updated_at=? WHERE waker_id_snapshot=? AND id=?')
        .run(
          json({
            input: current.input + usage.input,
            output: current.output + usage.output,
            total: current.total + usage.total,
          }),
          this.now(),
          wakerId,
          runId,
        );
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  appendWorkflowRunEvent(
    wakerId: string,
    runId: string,
    type: string,
    payload?: unknown,
  ): WorkflowRunEvent {
    return this.db.transaction(() => {
      this.requireWorkflowRun(wakerId, runId, [
        'queued',
        'running',
        'paused',
        'waiting_input',
        'waiting_child',
      ]);
      return this.appendWorkflowRunEventUnsafe(wakerId, runId, type, payload);
    })();
  }

  checkpointWorkflowRun(
    wakerId: string,
    runId: string,
    input: {
      nodeId: string;
      nodeKind: string;
      nextNodeId: string;
      context: Record<string, unknown>;
      output?: unknown;
      usage?: unknown;
    },
  ): WorkflowRun {
    return this.db.transaction(() => {
      const run = this.requireWorkflowRun(wakerId, runId, ['running']);
      if (run.currentNodeId !== input.nodeId) throw new Error('Workflow checkpoint node changed');
      const result = this.db
        .prepare(
          `UPDATE workflow_runs SET current_node_id=?,context=?,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='running' AND current_node_id=?`,
        )
        .run(input.nextNodeId, json(input.context), this.now(), wakerId, runId, input.nodeId);
      if (result.changes !== 1) throw new Error('Workflow checkpoint lost its claim');
      this.updateDerivedTask(wakerId, run.taskId, {}, 'workflow.progress', {
        runId,
        nodeId: input.nodeId,
        kind: input.nodeKind,
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'node_succeeded', {
        nodeId: input.nodeId,
        kind: input.nodeKind,
        ...(input.output === undefined ? {} : { output: input.output }),
        ...(input.usage === undefined ? {} : { usage: input.usage }),
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'checkpoint', {
        nodeId: input.nodeId,
        nextNodeId: input.nextNodeId,
        context: input.context,
      });
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  pauseWorkflowRun(
    wakerId: string,
    runId: string,
    payload: {
      nodeId: string;
      nextNodeId: string;
      context: Record<string, unknown>;
      resumeAt?: number;
    },
  ): WorkflowRun {
    if (!Number.isSafeInteger(payload.resumeAt) || (payload.resumeAt ?? 0) <= 0) {
      throw new Error('Workflow wake time is invalid');
    }
    return this.db.transaction(() => {
      const run = this.requireWorkflowRun(wakerId, runId, ['running']);
      if (run.currentNodeId !== payload.nodeId) throw new Error('Workflow wait node changed');
      const result = this.db
        .prepare(
          `UPDATE workflow_runs SET status='paused',context=?,wake_at=?,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='running' AND current_node_id=?`,
        )
        .run(json(payload.context), payload.resumeAt, this.now(), wakerId, runId, payload.nodeId);
      if (result.changes !== 1) throw new Error('Workflow wait lost its claim');
      this.updateDerivedTask(wakerId, run.taskId, { status: 'waiting' }, 'workflow.waiting', {
        runId,
        kind: 'wait',
        resumeAt: payload.resumeAt,
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'paused', payload);
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  resumePausedWorkflowRun(wakerId: string, runId: string): WorkflowRun {
    return this.db.transaction(() => {
      const run = this.requireWorkflowRun(wakerId, runId, ['paused']);
      if (run.wakeAt === null || run.wakeAt > this.now())
        throw new Error('Workflow wait is not due');
      const payload = this.latestWorkflowWaitPayload(wakerId, runId, 'paused');
      const result = this.db
        .prepare(
          `UPDATE workflow_runs SET status='running',current_node_id=?,context=?,wake_at=NULL,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='paused'`,
        )
        .run(payload.nextNodeId, json(payload.context), this.now(), wakerId, runId);
      if (result.changes !== 1) throw new Error('Workflow wait resume lost its claim');
      this.updateDerivedTask(wakerId, run.taskId, { status: 'running' }, 'workflow.resumed', {
        runId,
        kind: 'wait',
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'resumed', { kind: 'wait' });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'node_succeeded', {
        nodeId: payload.nodeId,
        kind: 'wait',
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'checkpoint', payload);
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  waitForWorkflowInput(
    wakerId: string,
    runId: string,
    payload: {
      nodeId: string;
      nextNodeId: string;
      context: Record<string, unknown>;
      inputKey?: string;
      prompt?: string;
    },
    action: { title: string; prompt: string },
  ): WorkflowRun {
    return this.db.transaction(() => {
      const run = this.requireWorkflowRun(wakerId, runId, ['running']);
      if (run.currentNodeId !== payload.nodeId) throw new Error('Workflow input node changed');
      const actionId = randomUUID();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO human_actions
           (id,waker_id,source,source_id,task_id,session_id,kind,title,prompt,status,version,created_at,updated_at)
           VALUES (?,?,?,?,?,?,'input',?,?,'pending',1,?,?)`,
        )
        .run(
          actionId,
          wakerId,
          'workflow',
          runId,
          run.taskId,
          run.sessionId,
          requireText(action.title, 'action title'),
          action.prompt,
          now,
          now,
        );
      const result = this.db
        .prepare(
          `UPDATE workflow_runs
           SET status='waiting_input',context=?,waiting_action_id=?,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='running' AND current_node_id=?`,
        )
        .run(json(payload.context), actionId, now, wakerId, runId, payload.nodeId);
      if (result.changes !== 1) throw new Error('Workflow input wait lost its claim');
      this.updateDerivedTask(wakerId, run.taskId, { status: 'waiting' }, 'workflow.waiting', {
        runId,
        kind: 'ask_user',
        actionId,
      });
      this.appendTaskEventUnsafe(wakerId, run.taskId, 'human_action.created', {
        actionId,
        kind: 'input',
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'waiting_input', {
        ...payload,
        kind: 'ask_user',
        actionId,
      });
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  resumeWorkflowRun(
    wakerId: string,
    runId: string,
    input?: unknown,
    expectedActionVersion?: number,
  ): WorkflowRun {
    return this.db.transaction(() => {
      const run = this.requireWorkflowRun(wakerId, runId, ['waiting_input']);
      const payload = this.latestWorkflowWaitPayload(wakerId, runId, 'waiting_input');
      if (!run.waitingActionId || payload.kind !== 'ask_user' || !payload.inputKey) {
        throw new Error('Workflow run is not asking for input');
      }
      const pendingAction = this.getHumanAction(wakerId, run.waitingActionId);
      if (!pendingAction) throw new Error('Workflow Human Action is missing');
      const actionVersion = expectedActionVersion ?? pendingAction.version;
      this.assertHumanActionVersion(pendingAction, actionVersion);
      const context = setWorkflowContextValue(run.context, payload.inputKey, input);
      const now = this.now();
      const action = this.db
        .prepare(
          `UPDATE human_actions
           SET status='handled',result=?,version=version+1,updated_at=?,resolved_at=?
           WHERE id=? AND waker_id=? AND source='workflow' AND source_id=?
             AND status='pending' AND version=? AND deleted_at IS NULL`,
        )
        .run(json(input), now, now, run.waitingActionId, wakerId, runId, actionVersion);
      if (action.changes !== 1)
        this.throwHumanActionConflict(wakerId, run.waitingActionId, actionVersion);
      const result = this.db
        .prepare(
          `UPDATE workflow_runs
           SET status='running',current_node_id=?,context=?,waiting_action_id=NULL,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='waiting_input'`,
        )
        .run(payload.nextNodeId, json(context), now, wakerId, runId);
      if (result.changes !== 1) throw new Error('Workflow input resume lost its claim');
      this.updateDerivedTask(wakerId, run.taskId, { status: 'running' }, 'workflow.resumed', {
        runId,
        kind: 'ask_user',
        actionId: run.waitingActionId,
      });
      this.appendTaskEventUnsafe(wakerId, run.taskId, 'human_action.handled', {
        actionId: run.waitingActionId,
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'resumed', { input });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'node_succeeded', {
        nodeId: payload.nodeId,
        kind: 'ask_user',
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'checkpoint', {
        nodeId: payload.nodeId,
        nextNodeId: payload.nextNodeId,
        context,
      });
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  waitForChildWorkflow(
    wakerId: string,
    runId: string,
    payload: {
      nodeId: string;
      nextNodeId: string;
      context: Record<string, unknown>;
      childRunId?: string;
      outputKey?: string;
    },
  ): WorkflowRun {
    if (!payload.childRunId) throw new Error('childRunId is required');
    return this.db.transaction(() => {
      const run = this.requireWorkflowRun(wakerId, runId, ['running']);
      const child = this.getWorkflowRun(wakerId, payload.childRunId!);
      if (!child || child.parentRunId !== runId || child.parentNodeId !== payload.nodeId) {
        throw new Error('Child workflow run does not match its parent');
      }
      const result = this.db
        .prepare(
          `UPDATE workflow_runs SET status='waiting_child',context=?,child_run_id=?,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='running' AND current_node_id=?`,
        )
        .run(json(payload.context), child.id, this.now(), wakerId, runId, payload.nodeId);
      if (result.changes !== 1) throw new Error('Workflow child wait lost its claim');
      this.updateDerivedTask(wakerId, run.taskId, { status: 'waiting' }, 'workflow.waiting', {
        runId,
        kind: 'child',
        childRunId: child.id,
      });
      this.appendWorkflowRunEventUnsafe(wakerId, runId, 'waiting_child', {
        ...payload,
        kind: 'child',
      });
      return this.getWorkflowRun(wakerId, runId)!;
    })();
  }

  startChildWorkflow(
    wakerId: string,
    parentRunId: string,
    input: {
      parentNodeId: string;
      workflowId: string;
      childInput?: unknown;
      nextNodeId: string;
      context: Record<string, unknown>;
      outputKey?: string;
    },
  ): WorkflowRun {
    return this.db.transaction(() => {
      const parent = this.requireWorkflowRun(wakerId, parentRunId, ['running']);
      if (parent.currentNodeId !== input.parentNodeId)
        throw new Error('Workflow call node changed');
      const child = this.runWorkflow(wakerId, input.workflowId, input.childInput, {
        parentRunId,
        parentNodeId: input.parentNodeId,
        depth: parent.depth + 1,
      });
      this.appendWorkflowRunEventUnsafe(wakerId, parentRunId, 'child_started', {
        nodeId: input.parentNodeId,
        childRunId: child.id,
      });
      this.waitForChildWorkflow(wakerId, parentRunId, {
        nodeId: input.parentNodeId,
        nextNodeId: input.nextNodeId,
        context: input.context,
        childRunId: child.id,
        ...(input.outputKey ? { outputKey: input.outputKey } : {}),
      });
      return child;
    })();
  }

  resumeWorkflowFromChild(wakerId: string, parentRunId: string, childRunId: string): WorkflowRun {
    return this.db.transaction(() => {
      const parent = this.requireWorkflowRun(wakerId, parentRunId, ['waiting_child']);
      const child = this.requireWorkflowRun(wakerId, childRunId, ['succeeded']);
      if (parent.childRunId !== child.id || child.parentRunId !== parent.id) {
        throw new Error('Child workflow run does not match its parent');
      }
      const payload = this.latestWorkflowWaitPayload(wakerId, parentRunId, 'waiting_child');
      const context = payload.outputKey
        ? setWorkflowContextValue(parent.context, payload.outputKey, child.output)
        : parent.context;
      const result = this.db
        .prepare(
          `UPDATE workflow_runs
           SET status='running',current_node_id=?,context=?,child_run_id=NULL,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status='waiting_child' AND child_run_id=?`,
        )
        .run(payload.nextNodeId, json(context), this.now(), wakerId, parentRunId, childRunId);
      if (result.changes !== 1) throw new Error('Workflow child resume lost its claim');
      this.updateDerivedTask(wakerId, parent.taskId, { status: 'running' }, 'workflow.resumed', {
        runId: parentRunId,
        kind: 'child',
        childRunId,
      });
      this.appendWorkflowRunEventUnsafe(wakerId, parentRunId, 'node_succeeded', {
        nodeId: payload.nodeId,
        kind: 'call_workflow',
        childRunId,
      });
      this.appendWorkflowRunEventUnsafe(wakerId, parentRunId, 'checkpoint', {
        nodeId: payload.nodeId,
        nextNodeId: payload.nextNodeId,
        context,
      });
      return this.getWorkflowRun(wakerId, parentRunId)!;
    })();
  }

  completeWorkflowRun(wakerId: string, runId: string, output?: unknown): WorkflowRun {
    return this.finishWorkflowRun(wakerId, runId, 'succeeded', output);
  }

  failWorkflowRun(wakerId: string, runId: string, error: string): WorkflowRun {
    requireText(error, 'error');
    return this.finishWorkflowRun(wakerId, runId, 'failed', undefined, error);
  }

  cancelWorkflowRun(wakerId: string, runId: string, expectedActionVersion?: number): WorkflowRun {
    return this.finishWorkflowRun(
      wakerId,
      runId,
      'cancelled',
      undefined,
      undefined,
      expectedActionVersion,
    );
  }

  retryWorkflowRun(wakerId: string, runId: string): WorkflowRun {
    return this.db.transaction(() => {
      const source = this.requireWorkflowRun(wakerId, runId, ['failed', 'cancelled']);
      if (!source.definitionSnapshot || !source.currentNodeId) {
        throw new Error('Workflow snapshot is not executable');
      }
      const id = randomUUID();
      const now = this.now();
      const taskValue = this.createDerivedTask({
        title: source.nameSnapshot,
        description: source.descriptionSnapshot,
        type: 'workflow',
        wakerId: source.wakerId,
        projectId: source.projectId,
        sourceType: 'workflow',
        sourceId: id,
        source: `workflow:${source.workflowId}`,
        runId: id,
      });
      this.db
        .prepare(
          `INSERT INTO workflow_runs
           (id,task_id,workflow_id,workflow_version,name_snapshot,description_snapshot,script_snapshot,
            definition_snapshot,waker_id_snapshot,project_id_snapshot,model_snapshot,thinking_snapshot,
            depth,attempt,retry_of_run_id,current_node_id,context,status,input,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          taskValue.id,
          source.workflowId,
          source.workflowVersion,
          source.nameSnapshot,
          source.descriptionSnapshot,
          source.scriptSnapshot,
          json(source.definitionSnapshot),
          source.wakerId,
          source.projectId,
          source.model,
          source.thinking,
          0,
          source.attempt + 1,
          source.id,
          source.currentNodeId,
          json(source.context),
          'queued',
          json(source.input),
          now,
          now,
        );
      this.appendWorkflowRunEventUnsafe(wakerId, id, 'queued', {
        input: source.input,
        retryOfRunId: source.id,
      });
      return this.getWorkflowRun(wakerId, id)!;
    })();
  }

  listWorkflowRunEvents(wakerId: string, runId: string): WorkflowRunEvent[] {
    if (!this.getWorkflowRun(wakerId, runId)) throw new Error('Workflow run not found');
    return this.db
      .prepare('SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY sequence')
      .all(runId)
      .map((row) => workflowRunEvent(row as Row));
  }

  getWorkflowRunTrace(wakerId: string, runId: string): WorkflowRunTrace {
    const run = this.getWorkflowRun(wakerId, runId);
    if (!run) throw new Error('Workflow run not found');
    return { run, events: this.listWorkflowRunEvents(wakerId, runId) };
  }

  private requireWorkflowRun(
    wakerId: string,
    runId: string,
    allowed: readonly WorkflowRunStatus[],
  ): WorkflowRun {
    const run = this.getWorkflowRun(wakerId, runId);
    if (!run) throw new Error('Workflow run not found');
    if (!allowed.includes(run.status))
      throw new Error(`Invalid workflow run transition from ${run.status}`);
    return run;
  }

  private appendWorkflowRunEventUnsafe(
    wakerId: string,
    runId: string,
    type: string,
    payload?: unknown,
  ): WorkflowRunEvent {
    requireText(type, 'event type');
    const sequence = this.db
      .prepare(
        `UPDATE workflow_runs SET event_sequence=event_sequence+1
         WHERE waker_id_snapshot=? AND id=? RETURNING event_sequence`,
      )
      .get(wakerId, runId) as { event_sequence: number } | undefined;
    if (!sequence) throw new Error('Workflow run not found');
    const result = this.db
      .prepare(
        'INSERT INTO workflow_run_events (run_id,sequence,type,payload,created_at) VALUES (?,?,?,?,?)',
      )
      .run(runId, sequence.event_sequence, type.trim(), json(payload), this.now());
    return workflowRunEvent(
      this.db
        .prepare('SELECT * FROM workflow_run_events WHERE id=?')
        .get(result.lastInsertRowid) as Row,
    );
  }

  private latestWorkflowWaitPayload(
    wakerId: string,
    runId: string,
    type: 'paused' | 'waiting_input' | 'waiting_child',
  ): Record<string, unknown> & {
    nodeId: string;
    nextNodeId: string;
    context: Record<string, unknown>;
    kind?: string;
    inputKey?: string;
    outputKey?: string;
  } {
    if (!this.getWorkflowRun(wakerId, runId)) throw new Error('Workflow run not found');
    const row = this.db
      .prepare(
        'SELECT payload FROM workflow_run_events WHERE run_id=? AND type=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(runId, type) as { payload: string | null } | undefined;
    const payload = parseJson(row?.payload) as Record<string, unknown> | undefined;
    if (
      !payload ||
      typeof payload.nodeId !== 'string' ||
      typeof payload.nextNodeId !== 'string' ||
      !payload.context ||
      typeof payload.context !== 'object' ||
      Array.isArray(payload.context)
    ) {
      throw new Error(`Workflow ${type} checkpoint is missing`);
    }
    return payload as ReturnType<WorkspaceStore['latestWorkflowWaitPayload']>;
  }

  private finishWorkflowRun(
    wakerId: string,
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    output?: unknown,
    error?: string,
    expectedActionVersion?: number,
  ): WorkflowRun {
    return this.db.transaction(() => {
      const allowed: WorkflowRunStatus[] =
        status === 'succeeded'
          ? ['running']
          : ['queued', 'running', 'paused', 'waiting_input', 'waiting_child'];
      const run = this.requireWorkflowRun(wakerId, runId, allowed);
      const now = this.now();
      if (run.waitingActionId) {
        const pendingAction = this.getHumanAction(wakerId, run.waitingActionId);
        if (!pendingAction) throw new Error('Workflow Human Action is missing');
        const actionVersion = expectedActionVersion ?? pendingAction.version;
        this.assertHumanActionVersion(pendingAction, actionVersion);
        const action = this.db
          .prepare(
            `UPDATE human_actions SET status='ignored',version=version+1,updated_at=?,resolved_at=?
             WHERE id=? AND waker_id=? AND source='workflow' AND source_id=?
               AND status='pending' AND version=? AND deleted_at IS NULL`,
          )
          .run(now, now, run.waitingActionId, wakerId, runId, actionVersion);
        if (action.changes !== 1)
          this.throwHumanActionConflict(wakerId, run.waitingActionId, actionVersion);
      }
      this.appendWorkflowRunEventUnsafe(
        wakerId,
        runId,
        status,
        status === 'failed' ? { error } : output,
      );
      const result = this.db
        .prepare(
          `UPDATE workflow_runs
           SET status=?,output=?,result=?,error=?,wake_at=NULL,waiting_action_id=NULL,child_run_id=NULL,
               completed_at=?,updated_at=?
           WHERE waker_id_snapshot=? AND id=? AND status=?`,
        )
        .run(
          status,
          json(output),
          json(output),
          error ?? null,
          now,
          now,
          wakerId,
          runId,
          run.status,
        );
      if (result.changes !== 1) throw new Error('Workflow terminal transition lost its claim');
      const taskStatus: TaskStatus =
        status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled';
      this.updateDerivedTask(
        wakerId,
        run.taskId,
        {
          status: taskStatus,
          result: json(output),
          error: error ?? null,
          completedAt: now,
        },
        `workflow.${status}`,
        { runId, status },
      );
      if (run.waitingActionId)
        this.appendTaskEventUnsafe(wakerId, run.taskId, 'human_action.ignored', {
          actionId: run.waitingActionId,
        });
      return this.getWorkflowRun(wakerId, runId)!;
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
    const kind = input.kind ?? (input.source === 'workflow' ? 'input' : 'confirm');
    requireEnum(kind, ['confirm', 'input'], 'human action kind');
    if (input.prompt.length > 10_000)
      throw new Error('Human Action prompt exceeds 10000 characters');
    const taskId = input.taskId ?? null;
    if (input.source === 'workflow' && !taskId)
      throw new Error('Workflow Human Action requires a Task');
    if (taskId && !this.getTask(input.wakerId, taskId))
      throw new Error('Human Action Task does not belong to Waker');
    const sessionId =
      input.sessionId ?? (taskId ? (this.getTask(input.wakerId, taskId)?.sessionId ?? null) : null);
    if (input.source === 'codex' && (!sessionId || sessionId !== input.sourceId))
      throw new Error('Codex Human Action requires its source Session');
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO human_actions
           (id,waker_id,source,source_id,task_id,session_id,kind,title,prompt,status,version,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'pending',1,?,?)`,
        )
        .run(
          id,
          input.wakerId,
          input.source,
          input.sourceId,
          taskId,
          sessionId,
          kind,
          input.title.trim(),
          input.prompt,
          now,
          now,
        );
      if (taskId)
        this.appendTaskEventUnsafe(input.wakerId, taskId, 'human_action.created', {
          actionId: id,
          kind,
        });
    })();
    return this.getHumanAction(input.wakerId, id)!;
  }

  listHumanActions(
    wakerId: string,
    statusOrFilter?: HumanActionStatus | HumanActionListFilter,
  ): HumanAction[] {
    return this.queryHumanActions(
      wakerId,
      typeof statusOrFilter === 'string' ? { status: statusOrFilter } : statusOrFilter,
    ).items;
  }

  queryHumanActions(wakerId: string, filter: HumanActionListFilter = {}): HumanActionPage {
    requireText(wakerId, 'wakerId');
    if (filter.status)
      requireEnum(filter.status, ['pending', 'handled', 'ignored'], 'human action status');
    if (filter.source) requireEnum(filter.source, ['workflow', 'codex'], 'human action source');
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid limit');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const clauses = ['waker_id=?', 'deleted_at IS NULL'];
    const values: unknown[] = [wakerId];
    if (filter.status) {
      clauses.push('status=?');
      values.push(filter.status);
    }
    if (filter.source) {
      clauses.push('source=?');
      values.push(filter.source);
    }
    if (filter.taskId) {
      clauses.push('task_id=?');
      values.push(filter.taskId);
    }
    const where = clauses.join(' AND ');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM human_actions WHERE ${where}`)
        .get(...values) as {
        count: number;
      }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT * FROM human_actions WHERE ${where}
         ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset);
    return { items: rows.map((row) => humanAction(row as Row)), total };
  }

  countHumanActions(
    wakerId: string,
    filter: Omit<HumanActionListFilter, 'limit' | 'offset'> = {},
  ): number {
    return this.queryHumanActions(wakerId, { ...filter, limit: 1 }).total;
  }

  private listHumanActionsForTask(wakerId: string, taskId: string): HumanAction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM human_actions
         WHERE waker_id=? AND task_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id`,
      )
      .all(wakerId, taskId);
    return rows.map((row) => humanAction(row as Row));
  }

  getHumanAction(wakerId: string, id: string): HumanAction | undefined {
    const row = this.db
      .prepare('SELECT * FROM human_actions WHERE id=? AND waker_id=? AND deleted_at IS NULL')
      .get(id, wakerId);
    return row ? humanAction(row as Row) : undefined;
  }

  updateHumanAction(
    wakerId: string,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<HumanActionInput, 'title' | 'prompt'>>,
  ): HumanAction | undefined {
    const current = this.getHumanAction(wakerId, id);
    if (!current) return undefined;
    if (current.status !== 'pending') throw new Error('Only pending human actions can be updated');
    this.assertHumanActionVersion(current, expectedVersion);
    const title = patch.title ?? current.title;
    requireText(title, 'title');
    const prompt = patch.prompt ?? current.prompt;
    if (prompt.length > 10_000) throw new Error('Human Action prompt exceeds 10000 characters');
    const result = this.db
      .prepare(
        `UPDATE human_actions SET title=?,prompt=?,version=version+1,updated_at=?
         WHERE id=? AND waker_id=? AND version=? AND status='pending' AND deleted_at IS NULL`,
      )
      .run(title.trim(), prompt, this.now(), id, wakerId, expectedVersion);
    if (result.changes !== 1) this.throwHumanActionConflict(wakerId, id, expectedVersion);
    return this.getHumanAction(wakerId, id);
  }

  resolveHumanAction(
    wakerId: string,
    id: string,
    expectedVersion: number,
    result: unknown,
  ): HumanAction {
    if (result === undefined) throw new Error('result is required');
    return this.finishHumanAction(wakerId, id, expectedVersion, 'handled', result);
  }

  ignoreHumanAction(wakerId: string, id: string, expectedVersion: number): HumanAction {
    return this.finishHumanAction(wakerId, id, expectedVersion, 'ignored');
  }

  private finishHumanAction(
    wakerId: string,
    id: string,
    expectedVersion: number,
    status: 'handled' | 'ignored',
    result?: unknown,
  ): HumanAction {
    return this.db.transaction(() => {
      const current = this.getHumanAction(wakerId, id);
      if (!current) throw new Error('Human action not found');
      if (current.source === 'workflow')
        throw new Error('Workflow Human Actions must be completed with their Workflow');
      this.assertHumanActionVersion(current, expectedVersion);
      const now = this.now();
      const changed = this.db
        .prepare(
          `UPDATE human_actions
           SET status=?,result=?,resolved_at=?,version=version+1,updated_at=?
           WHERE id=? AND waker_id=? AND version=? AND status='pending' AND deleted_at IS NULL`,
        )
        .run(status, json(result), now, now, id, wakerId, expectedVersion);
      if (changed.changes !== 1) this.throwHumanActionConflict(wakerId, id, expectedVersion);
      if (current.taskId)
        this.appendTaskEventUnsafe(wakerId, current.taskId, `human_action.${status}`, {
          actionId: id,
          ...(result === undefined ? {} : { result }),
        });
      return this.getHumanAction(wakerId, id)!;
    })();
  }

  deleteHumanAction(wakerId: string, id: string, expectedVersion: number): boolean {
    const current = this.getHumanAction(wakerId, id);
    if (!current) return false;
    if (current.status === 'pending') throw new Error('Pending Human Actions cannot be deleted');
    this.assertHumanActionVersion(current, expectedVersion);
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE human_actions SET deleted_at=?,version=version+1,updated_at=?
         WHERE id=? AND waker_id=? AND version=? AND deleted_at IS NULL`,
      )
      .run(now, now, id, wakerId, expectedVersion);
    if (result.changes !== 1) this.throwHumanActionConflict(wakerId, id, expectedVersion);
    return true;
  }

  private assertHumanActionVersion(value: HumanAction, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new Error('expectedVersion must be a positive integer');
    if (value.version !== expectedVersion)
      throw new HumanActionConflictError(expectedVersion, value.version);
  }

  private throwHumanActionConflict(wakerId: string, id: string, expectedVersion: number): never {
    const fresh = this.getHumanAction(wakerId, id);
    if (!fresh) throw new Error('Human action not found');
    throw new HumanActionConflictError(expectedVersion, fresh.version);
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

  deleteSessionContextsForWaker(wakerId: string): number {
    requireText(wakerId, 'wakerId');
    return this.db.prepare('DELETE FROM session_contexts WHERE waker_id = ?').run(wakerId).changes;
  }

  createTask(input: ManualTaskInput): Task {
    return this.db.transaction(() => {
      const id = input.id ?? randomUUID();
      const now = this.now();
      const status = input.status ?? 'queued';
      const priority = input.priority ?? 'normal';
      const position = input.position ?? 0;
      this.validateTaskValues({
        wakerId: input.wakerId,
        title: input.title,
        description: input.description ?? '',
        type: input.type ?? 'manual',
        status,
        priority,
        position,
        projectId: input.projectId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        taskId: id,
        error: input.error ?? null,
        completedAt: input.completedAt ?? null,
      });
      this.insertTaskUnsafe({
        id,
        title: input.title,
        description: input.description ?? '',
        type: 'manual',
        origin: 'manual',
        status,
        priority,
        position,
        wakerId: input.wakerId,
        projectId: input.projectId ?? null,
        sourceType: 'manual',
        sourceId: id,
        source: input.source ?? 'manual',
        runId: null,
        sessionId: null,
        parentTaskId: input.parentTaskId ?? null,
        result: input.result ?? null,
        error: input.error ?? null,
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        now,
      });
      this.appendTaskEventUnsafe(input.wakerId, id, 'created', { origin: 'manual' });
      return this.getTask(input.wakerId, id)!;
    })();
  }

  private createDerivedTask(input: {
    id?: string;
    title: string;
    description?: string;
    type: Exclude<TaskType, 'manual'>;
    wakerId: string;
    projectId: string | null;
    sourceType: Exclude<TaskSourceType, 'manual'>;
    sourceId: string;
    source: string;
    runId: string;
    sessionId?: string | null;
    parentTaskId?: string | null;
    result?: string | null;
    error?: string | null;
    status?: TaskStatus;
    startedAt?: number | null;
    completedAt?: number | null;
  }): Task {
    const id = input.id ?? randomUUID();
    const now = this.now();
    const status = input.status ?? 'queued';
    this.validateTaskValues({
      ...input,
      description: input.description ?? '',
      taskId: id,
      status,
      priority: 'normal',
      position: 0,
      parentTaskId: input.parentTaskId ?? null,
      error: input.error ?? null,
      completedAt: input.completedAt ?? null,
    });
    this.insertTaskUnsafe({
      ...input,
      id,
      description: input.description ?? '',
      origin: 'derived',
      status,
      priority: 'normal',
      position: 0,
      sessionId: input.sessionId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      result: input.result ?? null,
      error: input.error ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      now,
    });
    this.appendTaskEventUnsafe(input.wakerId, id, 'created', {
      origin: 'derived',
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    return this.getTask(input.wakerId, id)!;
  }

  private insertTaskUnsafe(input: {
    id: string;
    title: string;
    description: string;
    type: TaskType;
    origin: TaskOrigin;
    status: TaskStatus;
    priority: TaskPriority;
    position: number;
    wakerId: string;
    projectId: string | null;
    sourceType: TaskSourceType;
    sourceId: string;
    source: string;
    runId: string | null;
    sessionId: string | null;
    parentTaskId: string | null;
    result: string | null;
    error: string | null;
    startedAt: number | null;
    completedAt: number | null;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tasks
         (id,title,description,type,origin,status,priority,position,version,event_sequence,waker_id,project_id,
          source_type,source_id,source,run_id,session_id,parent_task_id,result,error,created_at,
          updated_at,last_active_at,started_at,completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.title.trim(),
        input.description,
        input.type,
        input.origin,
        input.status,
        input.priority,
        input.position,
        1,
        input.wakerId,
        input.projectId,
        input.sourceType,
        input.sourceId,
        input.source,
        input.runId,
        input.sessionId,
        input.parentTaskId,
        input.result,
        input.error,
        input.now,
        input.now,
        input.now,
        input.startedAt,
        input.completedAt,
      );
  }

  listTasks(wakerId: string, filter: TaskListFilter = {}): Task[] {
    return this.queryTasks(wakerId, filter).items;
  }

  queryTasks(wakerId: string, filter: TaskListFilter = {}): TaskPage {
    requireText(wakerId, 'wakerId');
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid limit');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const conditions = ['waker_id=?', 'deleted_at IS NULL'];
    const values: unknown[] = [wakerId];
    if (filter.projectId !== undefined) {
      conditions.push('project_id=?');
      values.push(filter.projectId);
    }
    const statuses = [...new Set(filter.status ? [filter.status] : (filter.statuses ?? []))];
    if (statuses?.length) {
      for (const status of statuses) requireEnum(status, taskStatuses, 'task status');
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses);
    }
    const types = [...new Set(filter.types ?? [])];
    if (types.length) {
      for (const type of types) requireEnum(type, taskTypes, 'task type');
      conditions.push(`type IN (${types.map(() => '?').join(',')})`);
      values.push(...types);
    }
    const sourceTypes = [...new Set(filter.sourceTypes ?? [])];
    if (sourceTypes.length) {
      for (const source of sourceTypes) requireEnum(source, taskSourceTypes, 'task source type');
      conditions.push(`source_type IN (${sourceTypes.map(() => '?').join(',')})`);
      values.push(...sourceTypes);
    }
    if (filter.priority) {
      requireEnum(filter.priority, taskPriorities, 'task priority');
      conditions.push('priority=?');
      values.push(filter.priority);
    }
    if (filter.parentTaskId !== undefined) {
      conditions.push(filter.parentTaskId === null ? 'parent_task_id IS NULL' : 'parent_task_id=?');
      if (filter.parentTaskId !== null) values.push(filter.parentTaskId);
    }
    const query = filter.query?.trim();
    if (query) {
      conditions.push(
        "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')",
      );
      const pattern = `%${escapeSqlLike(query)}%`;
      values.push(pattern, pattern, pattern);
    }
    const where = conditions.join(' AND ');
    const orderBy =
      filter.sort === 'updated_asc'
        ? 'last_active_at ASC,id ASC'
        : filter.sort === 'priority_desc'
          ? `CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
             last_active_at DESC,id ASC`
          : filter.sort === 'title_asc'
            ? 'title COLLATE NOCASE ASC,id ASC'
            : 'last_active_at DESC,id ASC';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`).get(...values) as {
        count: number;
      }
    ).count;
    const items = this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${where}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset)
      .map((row) => task(row as Row));
    return { items, total };
  }

  countTasks(wakerId: string, filter: Omit<TaskListFilter, 'limit' | 'offset'> = {}): number {
    return this.queryTasks(wakerId, { ...filter, limit: 1 }).total;
  }

  getTask(wakerId: string, id: string): Task | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id=? AND waker_id=? AND deleted_at IS NULL')
      .get(id, wakerId);
    return row ? task(row as Row) : undefined;
  }

  listTaskEvents(wakerId: string, taskId: string, limit = 200): TaskEvent[] {
    if (!this.getTask(wakerId, taskId)) throw new Error('Task not found');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid limit');
    return this.db
      .prepare(
        `SELECT * FROM task_events WHERE waker_id=? AND task_id=?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(wakerId, taskId, limit)
      .map((row) => taskEvent(row as Row))
      .reverse();
  }

  getTaskDetail(wakerId: string, taskId: string, eventLimit = 200): TaskDetail | undefined {
    const value = this.getTask(wakerId, taskId);
    if (!value) return undefined;
    return {
      task: value,
      events: this.listTaskEvents(wakerId, taskId, eventLimit),
      children: this.listTasks(wakerId, { parentTaskId: taskId, limit: 200 }),
      humanActions: this.listHumanActionsForTask(wakerId, taskId),
    };
  }

  getTaskDeleteImpact(wakerId: string, taskId: string): TaskDeleteImpact | undefined {
    const value = this.getTask(wakerId, taskId);
    if (!value) return undefined;
    const count = (sql: string) =>
      (this.db.prepare(sql).get(wakerId, taskId) as { count: number }).count;
    return {
      taskId,
      children: count(
        'SELECT COUNT(*) AS count FROM tasks WHERE waker_id=? AND parent_task_id=? AND deleted_at IS NULL',
      ),
      events: count('SELECT COUNT(*) AS count FROM task_events WHERE waker_id=? AND task_id=?'),
      humanActions: count(
        'SELECT COUNT(*) AS count FROM human_actions WHERE waker_id=? AND task_id=? AND deleted_at IS NULL',
      ),
      behavior: 'soft-delete',
    };
  }

  updateTask(wakerId: string, id: string, patch: ManualTaskUpdate): Task | undefined {
    return this.db.transaction(() => {
      const current = this.getTask(wakerId, id);
      if (!current) return undefined;
      if (current.origin !== 'manual') throw new Error('Derived Tasks cannot be edited directly');
      this.assertTaskVersion(current, patch.expectedVersion);
      const value = { ...current, ...patch };
      this.validateManualTaskTransition(current.status, value.status);
      const now = this.now();
      const terminal = ['completed', 'failed', 'cancelled'].includes(value.status);
      const completedAt = terminal ? (current.completedAt ?? now) : null;
      const startedAt = value.status === 'running' ? (current.startedAt ?? now) : current.startedAt;
      this.validateTaskValues({ ...value, completedAt, taskId: id });
      const result = this.db
        .prepare(
          `UPDATE tasks SET title=?,description=?,status=?,priority=?,position=?,project_id=?,parent_task_id=?,
           result=?,error=?,started_at=?,completed_at=?,version=version+1,updated_at=?,last_active_at=?
           WHERE id=? AND waker_id=? AND version=? AND origin='manual' AND deleted_at IS NULL`,
        )
        .run(
          value.title.trim(),
          value.description,
          value.status,
          value.priority,
          value.position,
          value.projectId,
          value.parentTaskId,
          value.result,
          value.error,
          startedAt,
          completedAt,
          now,
          now,
          id,
          wakerId,
          patch.expectedVersion,
        );
      if (result.changes !== 1) this.throwTaskConflict(wakerId, id, patch.expectedVersion);
      this.appendTaskEventUnsafe(wakerId, id, 'updated', {
        fromStatus: current.status,
        toStatus: value.status,
      });
      return this.getTask(wakerId, id)!;
    })();
  }

  deleteTask(wakerId: string, id: string, expectedVersion: number): boolean {
    return this.db.transaction(() => {
      const current = this.getTask(wakerId, id);
      if (!current) return false;
      if (current.origin !== 'manual') throw new Error('Derived Tasks cannot be deleted directly');
      this.assertTaskVersion(current, expectedVersion);
      if (
        this.db
          .prepare(
            `SELECT 1 FROM human_actions
             WHERE waker_id=? AND task_id=? AND status='pending' AND deleted_at IS NULL LIMIT 1`,
          )
          .get(wakerId, id)
      ) {
        throw new Error('Task has a pending Human Action');
      }
      const now = this.now();
      const children = this.db
        .prepare(
          `SELECT id FROM tasks
           WHERE waker_id=? AND parent_task_id=? AND deleted_at IS NULL ORDER BY id`,
        )
        .all(wakerId, id) as Array<{ id: string }>;
      for (const child of children) {
        this.db
          .prepare(
            `UPDATE tasks SET parent_task_id=NULL,version=version+1,updated_at=?,last_active_at=?
             WHERE id=? AND waker_id=? AND parent_task_id=?`,
          )
          .run(now, now, child.id, wakerId, id);
        this.appendTaskEventUnsafe(wakerId, child.id, 'parent.detached', { parentTaskId: id });
      }
      this.appendTaskEventUnsafe(wakerId, id, 'deleted');
      const result = this.db
        .prepare(
          `UPDATE tasks SET deleted_at=?,version=version+1,updated_at=?,last_active_at=?
           WHERE id=? AND waker_id=? AND version=? AND origin='manual' AND deleted_at IS NULL`,
        )
        .run(now, now, now, id, wakerId, expectedVersion);
      if (result.changes !== 1) this.throwTaskConflict(wakerId, id, expectedVersion);
      return true;
    })();
  }

  softDeleteBoardDataForWaker(wakerId: string): { tasks: number; humanActions: number } {
    return this.db.transaction(() => {
      const now = this.now();
      this.db
        .prepare(
          `UPDATE human_actions
           SET status='ignored',resolved_at=?,version=version+1,updated_at=?
           WHERE waker_id=? AND status='pending' AND deleted_at IS NULL`,
        )
        .run(now, now, wakerId);
      const humanActions = this.db
        .prepare(
          `UPDATE human_actions SET deleted_at=?,version=version+1,updated_at=?
           WHERE waker_id=? AND deleted_at IS NULL`,
        )
        .run(now, now, wakerId).changes;
      const tasks = this.db
        .prepare(
          `UPDATE tasks SET deleted_at=?,version=version+1,updated_at=?,last_active_at=?
           WHERE waker_id=? AND deleted_at IS NULL`,
        )
        .run(now, now, now, wakerId).changes;
      return { tasks, humanActions };
    })();
  }

  private updateDerivedTask(
    wakerId: string,
    taskId: string,
    patch: {
      status?: TaskStatus;
      sessionId?: string | null;
      result?: string | null;
      error?: string | null;
      startedAt?: number | null;
      completedAt?: number | null;
      parentTaskId?: string | null;
    },
    eventType: string,
    payload?: unknown,
  ): Task {
    const current = this.getTask(wakerId, taskId);
    if (!current || current.origin !== 'derived') throw new Error('Derived Task not found');
    const value = { ...current, ...patch };
    this.validateTaskValues({ ...value, taskId });
    const now = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status=?,session_id=?,parent_task_id=?,result=?,error=?,started_at=?,
         completed_at=?,version=version+1,updated_at=?,last_active_at=?
         WHERE id=? AND waker_id=? AND origin='derived' AND deleted_at IS NULL`,
      )
      .run(
        value.status,
        value.sessionId,
        value.parentTaskId,
        value.result,
        value.error,
        value.startedAt,
        value.completedAt,
        now,
        now,
        taskId,
        wakerId,
      );
    this.appendTaskEventUnsafe(wakerId, taskId, eventType, payload);
    return this.getTask(wakerId, taskId)!;
  }

  private appendTaskEventUnsafe(
    wakerId: string,
    taskId: string,
    type: string,
    payload?: unknown,
  ): TaskEvent {
    const sequence = this.db
      .prepare(
        `UPDATE tasks SET event_sequence=event_sequence+1
         WHERE id=? AND waker_id=? RETURNING event_sequence,status`,
      )
      .get(taskId, wakerId) as { event_sequence: number; status: TaskStatus } | undefined;
    if (!sequence) throw new Error('Task not found');
    const inserted = this.db
      .prepare(
        `INSERT INTO task_events(task_id,waker_id,sequence,type,status,payload,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        taskId,
        wakerId,
        sequence.event_sequence,
        requireText(type, 'task event type'),
        sequence.status,
        json(payload),
        this.now(),
      );
    return taskEvent(
      this.db.prepare('SELECT * FROM task_events WHERE id=?').get(inserted.lastInsertRowid) as Row,
    );
  }

  private validateTaskValues(value: {
    wakerId: string;
    title: string;
    description: string;
    type: TaskType;
    status: TaskStatus;
    priority: TaskPriority;
    position: number;
    projectId: string | null;
    parentTaskId: string | null;
    taskId: string;
    error: string | null;
    completedAt: number | null;
  }): void {
    requireText(value.wakerId, 'wakerId');
    requireText(value.title, 'title');
    if (value.description.length > 4_000)
      throw new Error('Task description exceeds 4000 characters');
    requireEnum(value.type, taskTypes, 'task type');
    requireEnum(value.status, taskStatuses, 'task status');
    requireEnum(value.priority, taskPriorities, 'task priority');
    if (!Number.isSafeInteger(value.position) || value.position < 0)
      throw new Error('Task position must be a non-negative integer');
    if (value.status === 'completed' && value.completedAt == null)
      throw new Error('completedAt is required');
    if (value.status === 'failed' && (value.completedAt == null || !value.error))
      throw new Error('failed task requires error and completedAt');
    if (value.status === 'cancelled' && value.completedAt == null)
      throw new Error('cancelled task requires completedAt');
    if (value.projectId && !this.getOwnedProject(value.wakerId, value.projectId))
      throw new Error('Project does not belong to Waker');
    this.assertTaskParent(value.wakerId, value.parentTaskId, value.taskId);
  }

  private assertTaskParent(wakerId: string, parentTaskId: string | null, taskId: string): void {
    if (!parentTaskId) return;
    if (parentTaskId === taskId) throw new Error('Task cannot be its own parent');
    let current: string | null = parentTaskId;
    const visited = new Set<string>();
    while (current) {
      if (current === taskId) throw new Error('Task parent cycle is not allowed');
      if (visited.has(current)) throw new Error('Task parent cycle is not allowed');
      visited.add(current);
      const parent = this.getTask(wakerId, current);
      if (!parent) throw new Error('Parent Task does not belong to Waker');
      current = parent.parentTaskId;
    }
  }

  private validateManualTaskTransition(from: TaskStatus, to: TaskStatus): void {
    if (from === to) return;
    const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
      queued: ['waiting', 'running', 'completed', 'failed', 'cancelled'],
      waiting: ['queued', 'running', 'completed', 'failed', 'cancelled'],
      running: ['waiting', 'completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    };
    if (!allowed[from].includes(to))
      throw new Error(`Invalid Task transition from ${from} to ${to}`);
  }

  private assertTaskVersion(value: Task, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new Error('expectedVersion must be a positive integer');
    if (value.version !== expectedVersion)
      throw new TaskConflictError(expectedVersion, value.version);
  }

  private throwTaskConflict(wakerId: string, id: string, expectedVersion: number): never {
    const fresh = this.getTask(wakerId, id);
    if (!fresh) throw new Error('Task not found');
    throw new TaskConflictError(expectedVersion, fresh.version);
  }
}

function escapeSqlLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function workflowSnapshotText(value: Workflow): string {
  return JSON.stringify(
    {
      name: value.name,
      description: value.description,
      projectId: value.projectId,
      model: value.model,
      thinking: value.thinking,
      status: value.status,
      definition: value.definition,
    },
    null,
    2,
  );
}

function workflowVersionSnapshotText(value: WorkflowVersion): string {
  return JSON.stringify(
    {
      name: value.name,
      description: value.description,
      projectId: value.projectId,
      model: value.model,
      thinking: value.thinking,
      status: value.status,
      definition: value.definition,
    },
    null,
    2,
  );
}

function unifiedLineDiff(
  before: string,
  after: string,
  beforeLabel: string,
  afterLabel: string,
): string {
  if (before === after) return `--- ${beforeLabel}\n+++ ${afterLabel}\n`;
  const left = before.trimEnd().split('\n');
  const right = after.trimEnd().split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    '@@',
    ...left.slice(Math.max(0, prefix - 2), prefix).map((line) => ` ${line}`),
    ...left.slice(prefix, left.length - suffix).map((line) => `-${line}`),
    ...right.slice(prefix, right.length - suffix).map((line) => `+${line}`),
    ...left
      .slice(left.length - suffix, Math.min(left.length, left.length - suffix + 2))
      .map((line) => ` ${line}`),
    '',
  ].join('\n');
}
