import type {
  ChatUsage,
  SessionDebugNodeStatus,
  SessionDebugTimeline,
  SessionDebugTimelineNode,
  SessionDebugTimelineRound,
  SessionTurnTrace,
} from '@waker/contracts';
import { classifyTurnError } from './error-classification.js';

/**
 * Session-runtime 诊断三件套（复刻 QoderWake 0.4.2 的 runtime diagnostics /
 * debug-timeline / traces）的本地数据源：Codex rollout JSONL。旧版数据来自
 * conversation-trace 日志和 task_traces 表；本地等价物是 rollout 里的
 * task_started / turn_context / task_complete / token_count / error / turn_aborted
 * 记录。与 parseRolloutMessages 一样防御性解析：未知行跳过，坏行不让解析失败。
 */

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

/** 一个 turn 的解析中间态；events 即 debug-timeline 的 node 列表（按产生顺序）。 */
interface TurnAccumulator {
  turnId?: string;
  model?: string;
  effort?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  status: 'completed' | 'failed' | 'aborted' | 'running';
  usage?: ChatUsage;
  toolIds: Set<string>;
  toolNodes: Map<string, SessionDebugTimelineNode>;
  errorMessage?: string;
  events: SessionDebugTimelineNode[];
}

/** analyzeRollout 的输出：事件计数、会话级元信息/累计用量和按 turn 归组的解析结果。 */
export interface RolloutAnalysis {
  meta: { cliVersion?: string; modelProvider?: string };
  totalEvents: number;
  eventsByType: Record<string, number>;
  cumulativeUsage?: ChatUsage;
  turns: TurnAccumulator[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function redactPrivateText(text: string, privateRoots: readonly string[]): string {
  return [...new Set(privateRoots.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .reduce((result, root) => result.split(root).join('.'), text);
}

function timeMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationBetween(start: string, end: string): number | null {
  const startMs = timeMs(start);
  const endMs = timeMs(end);
  return startMs && endMs && endMs >= startMs ? Math.round(endMs - startMs) : null;
}

/** token_count 的 total_token_usage（会话级累计）与 last_token_usage（本轮）都是同一形状。 */
function usageFrom(value: unknown): ChatUsage | undefined {
  const usage = asRecord(value);
  const input = asFiniteNumber(usage?.input_tokens);
  const output = asFiniteNumber(usage?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const total = asFiniteNumber(usage?.total_tokens) ?? input + output;
  return total > 0 ? { input, output, total } : undefined;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'unknown';
}

/** 旧版 severityFor 的裁剪版：本地没有耗时阈值语义，失败/取消即 danger，其余 normal。 */
function severityForStatus(status: SessionDebugNodeStatus): 'normal' | 'danger' {
  return status === 'failed' || status === 'cancelled' ? 'danger' : 'normal';
}

/** item_completed 的 item.type / function_call 的 name 归一化（对齐 rollout.ts 的去下划线小写规则）。 */
function normalizeItemType(value: unknown): string {
  return String(value ?? '')
    .replaceAll('_', '')
    .toLowerCase();
}

/** 非消息/推理类的 item_completed 才算工具调用（CommandExecution / FileChange / McpToolCall / TodoList 等）。 */
function isToolItemType(normalized: string): boolean {
  return Boolean(
    normalized && !['usermessage', 'agentmessage', 'message', 'reasoning'].includes(normalized),
  );
}

function toolNameForItem(item: Record<string, unknown>, normalized: string): string {
  if (normalized === 'commandexecution') return 'command_execution';
  if (normalized === 'filechange') return 'file_change';
  if (normalized === 'mcptoolcall') {
    const server = asString(item.server) ?? 'mcp';
    const tool = asString(item.tool) ?? 'tool';
    return `${server}.${tool}`;
  }
  if (normalized === 'todolist') return 'plan';
  return normalized;
}

/**
 * 解析一个 rollout 文件为诊断分析结果。turn 边界以 task_started / turn_context 的
 * turn_id 为准；没有 turn_id 的记录归入当前（最后一个）turn，任何 turn 边界都
 * 没出现时隐式归入同一个 turn，保证旧格式文件也能产出时间线。
 */
export function analyzeRollout(
  content: string,
  additionalPrivateRoots: readonly string[] = [],
): RolloutAnalysis {
  const analysis: RolloutAnalysis = {
    meta: {},
    totalEvents: 0,
    eventsByType: {},
    turns: [],
  };
  const turnsByTurnId = new Map<string, TurnAccumulator>();
  let privateRoots = [...additionalPrivateRoots];
  let nodeCounter = 0;

  const newTurn = (turnId?: string): TurnAccumulator => {
    const turn: TurnAccumulator = {
      ...(turnId ? { turnId } : {}),
      status: 'running',
      toolIds: new Set(),
      toolNodes: new Map(),
      events: [],
    };
    analysis.turns.push(turn);
    if (turnId) turnsByTurnId.set(turnId, turn);
    return turn;
  };
  const turnFor = (turnId: unknown): TurnAccumulator => {
    const id = asString(turnId);
    if (id) return turnsByTurnId.get(id) ?? newTurn(id);
    return analysis.turns.at(-1) ?? newTurn();
  };
  const currentTurn = (): TurnAccumulator => analysis.turns.at(-1) ?? newTurn();

  const addNode = (
    turn: TurnAccumulator,
    kind: string,
    timestamp: string,
    options: {
      status?: SessionDebugNodeStatus;
      durationMs?: number | null;
      reasonCode?: string;
      supportInfo?: Record<string, unknown>;
    } = {},
  ): SessionDebugTimelineNode => {
    const status = options.status ?? 'completed';
    const supportInfo: Record<string, unknown> = { event: kind };
    if (turn.turnId) supportInfo.turnId = turn.turnId;
    Object.assign(supportInfo, options.supportInfo ?? {});
    const node: SessionDebugTimelineNode = {
      id: `${kind}-${(nodeCounter += 1)}-${sanitizeId(timestamp || 'unknown')}`,
      kind,
      startedAt: timestamp,
      durationMs: options.durationMs ?? null,
      status,
      severity: severityForStatus(status),
      ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
      supportInfo,
    };
    turn.events.push(node);
    return node;
  };

  const countRecord = (type: string, payloadType?: string): void => {
    const key = payloadType ? `${type}/${payloadType}` : type;
    analysis.eventsByType[key] = (analysis.eventsByType[key] ?? 0) + 1;
    analysis.totalEvents += 1;
  };

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: RolloutRecord;
    try {
      record = JSON.parse(trimmed) as RolloutRecord;
    } catch {
      continue; // 半行/坏行（崩溃截断）直接跳过。
    }
    const type = asString(record.type);
    const payload = asRecord(record.payload);
    if (!type || !payload) continue;
    const payloadType = asString(payload.type);
    countRecord(type, payloadType);
    const timestamp = asString(record.timestamp) ?? '';

    if (type === 'session_meta') {
      const cliVersion = asString(payload.cli_version);
      const modelProvider = asString(payload.model_provider);
      if (cliVersion && !analysis.meta.cliVersion) analysis.meta.cliVersion = cliVersion;
      if (modelProvider && !analysis.meta.modelProvider)
        analysis.meta.modelProvider = modelProvider;
      if (typeof payload.cwd === 'string') privateRoots = [...privateRoots, payload.cwd];
      continue;
    }

    if (type === 'turn_context') {
      const turn = turnFor(payload.turn_id);
      const model = asString(payload.model);
      const effort = asString(payload.effort);
      if (model) turn.model = model;
      if (effort) turn.effort = effort;
      if (!turn.startedAt && timestamp) turn.startedAt = timestamp;
      continue;
    }

    if (type === 'response_item' && payloadType === 'message') {
      const role = asString(payload.role);
      if (role === 'user' || role === 'assistant') {
        const kind = role === 'user' ? 'user_message' : 'assistant_message';
        addNode(currentTurn(), kind, timestamp, { durationMs: 0 });
      }
      continue;
    }

    if (type === 'response_item' && payloadType === 'reasoning') {
      addNode(currentTurn(), 'reasoning', timestamp, { durationMs: 0 });
      continue;
    }

    if (type === 'response_item' && payloadType === 'function_call') {
      const toolId = asString(payload.call_id) ?? asString(payload.id);
      if (toolId) {
        const turn = currentTurn();
        turn.toolIds.add(toolId);
        const node = addNode(turn, 'tool_call', timestamp, {
          status: 'running',
          supportInfo: { toolId, name: asString(payload.name) ?? 'tool' },
        });
        turn.toolNodes.set(toolId, node);
      }
      continue;
    }

    if (type === 'response_item' && payloadType === 'function_call_output') {
      const toolId = asString(payload.call_id);
      const turn = currentTurn();
      const node = toolId ? turn.toolNodes.get(toolId) : undefined;
      if (node) {
        node.status = 'completed';
        node.severity = 'normal';
        node.durationMs = durationBetween(node.startedAt, timestamp);
      }
      continue;
    }

    if (type === 'event_msg' && payloadType === 'task_started') {
      const turn = turnFor(payload.turn_id);
      turn.startedAt = timestamp || turn.startedAt;
      const contextWindow = asFiniteNumber(payload.model_context_window);
      addNode(turn, 'turn_start', timestamp, {
        durationMs: 0,
        supportInfo: {
          ...(turn.model ? { model: turn.model } : {}),
          ...(turn.effort ? { effort: turn.effort } : {}),
          ...(contextWindow !== undefined ? { modelContextWindow: contextWindow } : {}),
        },
      });
      continue;
    }

    if (type === 'event_msg' && payloadType === 'task_complete') {
      const turn = turnFor(payload.turn_id);
      turn.finishedAt = timestamp;
      const durationMs = asFiniteNumber(payload.duration_ms);
      const timeToFirstTokenMs = asFiniteNumber(payload.time_to_first_token_ms);
      if (durationMs !== undefined) turn.durationMs = Math.max(0, Math.round(durationMs));
      if (timeToFirstTokenMs !== undefined)
        turn.timeToFirstTokenMs = Math.max(0, Math.round(timeToFirstTokenMs));
      if (turn.status === 'running') turn.status = 'completed';
      addNode(turn, 'turn_complete', timestamp, { durationMs: turn.durationMs ?? null });
      continue;
    }

    if (type === 'event_msg' && payloadType === 'token_count') {
      const info = asRecord(payload.info) ?? payload;
      const turnUsage = usageFrom(info.last_token_usage);
      const cumulative = usageFrom(info.total_token_usage) ?? usageFrom(info);
      const turn = currentTurn();
      if (turnUsage) turn.usage = turnUsage;
      if (cumulative) analysis.cumulativeUsage = cumulative;
      addNode(turn, 'token_usage', timestamp, {
        durationMs: 0,
        supportInfo: turnUsage ? { ...turnUsage } : cumulative ? { ...cumulative } : {},
      });
      continue;
    }

    if (type === 'event_msg' && payloadType === 'item_completed') {
      const item = asRecord(payload.item);
      const normalized = normalizeItemType(item?.type);
      if (item && isToolItemType(normalized)) {
        const toolId = asString(item.id);
        const turn = currentTurn();
        if (toolId) {
          const existing = turn.toolNodes.get(toolId);
          // function_call_output 先完成的不覆盖：item_completed 是同一次调用的另一条观测。
          if (existing && existing.status === 'running') {
            existing.status = 'completed';
            existing.severity = 'normal';
            existing.durationMs = durationBetween(existing.startedAt, timestamp);
          } else if (!existing) {
            turn.toolIds.add(toolId);
            const node = addNode(turn, 'tool_call', timestamp, {
              supportInfo: { toolId, name: toolNameForItem(item, normalized) },
            });
            turn.toolNodes.set(toolId, node);
          }
        }
      }
      continue;
    }

    if (type === 'event_msg' && payloadType === 'error') {
      const turn = turnFor(payload.turn_id);
      turn.status = 'failed';
      const message = asString(payload.message);
      if (message) turn.errorMessage = redactPrivateText(message, privateRoots);
      const reasonCode = message ? classifyTurnError({ message }).kind : 'generic';
      addNode(turn, 'error', timestamp, { status: 'failed', reasonCode });
      continue;
    }

    if (type === 'event_msg' && payloadType === 'turn_aborted') {
      const turn = turnFor(payload.turn_id);
      if (turn.status !== 'failed') turn.status = 'aborted';
      addNode(turn, 'turn_aborted', timestamp, { status: 'cancelled' });
      continue;
    }
    // world_state / compact / thread_settings_applied 等：计入事件计数，不产生时间线节点。
  }

  return analysis;
}

/** 对齐旧版 summarizeStatus 的优先级（本地不产出 waiting_user / recovered）。 */
function summarizeStatus(statuses: readonly SessionDebugNodeStatus[]): string {
  if (statuses.length === 0) return 'insufficient_data';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('cancelled')) return 'cancelled';
  if (statuses.includes('running')) return 'running';
  return 'completed';
}

function roundStatus(turn: TurnAccumulator): SessionDebugNodeStatus {
  if (turn.status === 'aborted') return 'cancelled';
  return turn.status;
}

/** 旧版 roundDurationMs 的等价物：优先 task_complete 的 duration_ms，否则由节点首尾推导。 */
function roundDurationMs(turn: TurnAccumulator, nodes: SessionDebugTimelineNode[]): number | null {
  if (turn.durationMs !== undefined) return turn.durationMs;
  if (nodes.length === 0) return null;
  const startMs = timeMs(nodes[0]!.startedAt);
  if (!startMs) return null;
  const last = nodes[nodes.length - 1]!;
  const endMs = timeMs(last.startedAt) + (last.durationMs ?? 0);
  return endMs >= startMs ? Math.round(endMs - startMs) : null;
}

/**
 * 由分析结果构建 debug-timeline（整体形状对齐旧版 buildSessionDebugTimeline：
 * summary + rounds + nodes）。limit 取最近 N 轮；无 turn 数据时 available=false。
 */
export function buildSessionDebugTimeline(input: {
  sessionId: string;
  analysis: RolloutAnalysis;
  limit?: number;
  generatedAt?: Date;
}): SessionDebugTimeline {
  const generatedAt = input.generatedAt ?? new Date();
  const allTurns = input.analysis.turns;
  if (allTurns.length === 0) {
    return {
      sessionId: input.sessionId,
      available: false,
      generatedAt: generatedAt.toISOString(),
      summary: {
        status: 'insufficient_data',
        totalDurationMs: null,
        roundCount: 0,
        errorCount: 0,
        warningCount: 0,
      },
      rounds: [],
    };
  }

  // 先按完整历史编号（对齐旧版 index/title 语义），limit 只在最后截最近 N 轮。
  const allRounds: SessionDebugTimelineRound[] = allTurns.map((turn, position) => {
    const index = position + 1;
    const nodes = [...turn.events].sort(
      (left, right) => timeMs(left.startedAt) - timeMs(right.startedAt),
    );
    const startedAt = turn.startedAt ?? nodes[0]?.startedAt ?? generatedAt.toISOString();
    return {
      id: `round-${index}-${sanitizeId(turn.turnId ?? 'turn')}`,
      index,
      requestSetId: turn.turnId ?? input.sessionId,
      title: index === 1 ? 'round_initial' : 'round_followup',
      startedAt,
      durationMs: roundDurationMs(turn, nodes),
      status: roundStatus(turn),
      nodes,
    };
  });
  const rounds =
    input.limit !== undefined && allRounds.length > input.limit
      ? allRounds.slice(allRounds.length - input.limit)
      : allRounds;

  const allNodes = rounds.flatMap((round) => round.nodes);
  const errorCount = allNodes.filter(
    (node) => node.status === 'failed' || node.severity === 'danger',
  ).length;
  const warningCount = allNodes.filter((node) => node.severity === 'warning').length;
  const primaryDelay = allNodes
    .filter((node) => node.durationMs != null)
    .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))[0];
  const durations = rounds
    .map((round) => round.durationMs)
    .filter((value): value is number => typeof value === 'number');

  return {
    sessionId: input.sessionId,
    available: true,
    generatedAt: generatedAt.toISOString(),
    summary: {
      status: summarizeStatus(rounds.map((round) => round.status)) as SessionDebugTimeline['summary']['status'],
      totalDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
      roundCount: rounds.length,
      errorCount,
      warningCount,
      ...(primaryDelay ? { primaryDelayNodeId: primaryDelay.id } : {}),
    },
    rounds,
  };
}

/** 由分析结果构建每次 turn 的 trace 列表（traces 端点的 items）。 */
export function tracesFromAnalysis(analysis: RolloutAnalysis): SessionTurnTrace[] {
  return analysis.turns.map((turn, position) => ({
    traceId: turn.turnId ?? `turn-${position + 1}`,
    index: position + 1,
    status: turn.status,
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.effort ? { thinking: turn.effort } : {}),
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.finishedAt ? { finishedAt: turn.finishedAt } : {}),
    ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
    ...(turn.timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: turn.timeToFirstTokenMs }
      : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    toolCallCount: turn.toolIds.size,
    ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
  }));
}
