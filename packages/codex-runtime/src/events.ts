import type { ChatStreamEvent, ChatUsage } from '@waker/contracts';

/**
 * Structural view of the Codex SDK ThreadEvent/ThreadItem unions (verified against
 * @openai/codex-sdk@0.149.0). Declared locally so the normalizer stays decoupled
 * from SDK type names; index.ts casts the SDK events onto these shapes.
 */

export interface CodexTurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}

export type CodexThreadItem =
  | { type: 'agent_message'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | {
      type: 'command_execution';
      id: string;
      command: string;
      aggregated_output: string;
      exit_code?: number;
      status: 'in_progress' | 'completed' | 'failed';
    }
  | {
      type: 'file_change';
      id: string;
      changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>;
      status: 'completed' | 'failed';
    }
  | {
      type: 'mcp_tool_call';
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      result?: unknown;
      error?: unknown;
      status: string;
    }
  | { type: 'web_search'; id: string; query: string }
  | { type: 'todo_list'; id: string; items: Array<{ text: string; completed: boolean }> }
  | { type: 'error'; id: string; message: string };

export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: CodexTurnUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexThreadItem }
  | { type: 'item.updated'; item: CodexThreadItem }
  | { type: 'item.completed'; item: CodexThreadItem }
  | { type: 'error'; message: string };

/** args/result frames are truncated JSON text; the Web client renders them as plain text. */
const TOOL_PAYLOAD_LIMIT = 4 * 1024;

function truncate(text: string): string {
  return text.length > TOOL_PAYLOAD_LIMIT
    ? `${text.slice(0, TOOL_PAYLOAD_LIMIT)}…[truncated]`
    : text;
}

function jsonSummary(value: unknown, sanitize: (text: string) => string): string | undefined {
  if (value === undefined || value === null) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return truncate(sanitize(serialized ?? ''));
}

/** Removes server-owned absolute roots before text crosses into browser-visible contracts. */
export function redactPrivateRoots(text: string, privateRoots: readonly string[]): string {
  return privateRoots
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((visible, root) => visible.split(root).join('.'), text);
}

export function chatUsageFromTurnUsage(usage: CodexTurnUsage): ChatUsage {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return { input, output, total: input + output };
}

/** Maps item.started / item.updated / item.completed onto the tool frame phase. */
type ToolPhase = 'start' | 'update' | 'end';

interface ToolPayload {
  toolName: string;
  args?: string;
  result?: string;
  isError?: boolean;
}

function toolPayload(
  item: CodexThreadItem,
  sanitize: (text: string) => string,
): ToolPayload | undefined {
  switch (item.type) {
    case 'command_execution':
      return {
        toolName: 'command_execution',
        args: jsonSummary({ command: item.command }, sanitize),
        result: truncate(sanitize(item.aggregated_output ?? '')),
        isError:
          item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0),
      };
    case 'file_change':
      return {
        toolName: 'file_change',
        args: jsonSummary({ changes: item.changes }, sanitize),
        result: item.status,
        isError: item.status === 'failed',
      };
    case 'mcp_tool_call':
      return {
        toolName: `${item.server}.${item.tool}`,
        args: jsonSummary(item.arguments, sanitize),
        result:
          item.error !== undefined && item.error !== null
            ? jsonSummary(item.error, sanitize)
            : (jsonSummary(item.result, sanitize) ?? item.status),
        isError: item.status === 'failed' || (item.error !== undefined && item.error !== null),
      };
    case 'web_search':
      return { toolName: 'web_search', args: jsonSummary({ query: item.query }, sanitize) };
    case 'todo_list':
      return { toolName: 'plan', args: jsonSummary({ items: item.items }, sanitize) };
    default:
      return undefined;
  }
}

/**
 * Normalizes one turn's Codex ThreadEvent stream into contracts ChatStreamEvent
 * frames. Stateful per turn: agent_message/reasoning items arrive as cumulative
 * text snapshots, so the emitted delta is the suffix vs the previously seen text
 * for that item id. turn.completed carries no frame — the caller folds it into
 * the terminal `done` payload via chatUsageFromTurnUsage.
 */
export class CodexEventNormalizer {
  /** item id → 已转发的累计文本；delta = 新快照相对它的增量后缀。 */
  private readonly emittedText = new Map<string, string>();
  private readonly emittedThinking = new Map<string, string>();

  constructor(private readonly privateRoots: readonly string[] = []) {}

  private readonly sanitize = (text: string): string => redactPrivateRoots(text, this.privateRoots);

  normalize(event: CodexThreadEvent): ChatStreamEvent[] {
    switch (event.type) {
      case 'item.started':
        return this.onItem(event.item, 'start');
      case 'item.updated':
        return this.onItem(event.item, 'update');
      case 'item.completed':
        return this.onItem(event.item, 'end');
      case 'turn.failed':
        return [{ type: 'error', error: this.sanitize(event.error.message) }];
      case 'error':
        return [{ type: 'error', error: this.sanitize(event.message) }];
      default:
        return []; // thread.started / turn.started / turn.completed 由调用方处理。
    }
  }

  private onItem(item: CodexThreadItem, phase: ToolPhase): ChatStreamEvent[] {
    if (item.type === 'agent_message')
      return this.onTextItem(this.emittedText, item, 'text_delta', phase);
    if (item.type === 'reasoning')
      return this.onTextItem(this.emittedThinking, item, 'thinking_delta', phase);
    if (item.type === 'error')
      return phase === 'start' ? [] : [{ type: 'error', error: this.sanitize(item.message) }];

    const payload = toolPayload(item, this.sanitize);
    if (!payload) return [];
    const frame: ChatStreamEvent = {
      type: 'tool',
      phase,
      toolCallId: item.id,
      toolName: payload.toolName,
      ...(payload.args !== undefined ? { args: payload.args } : {}),
      ...(phase !== 'start' && payload.result !== undefined ? { result: payload.result } : {}),
      ...(phase === 'end' && payload.isError ? { isError: true } : {}),
    };
    return [frame];
  }

  private onTextItem(
    emitted: Map<string, string>,
    item: { id: string; text: string },
    kind: 'text_delta' | 'thinking_delta',
    phase: ToolPhase,
  ): ChatStreamEvent[] {
    if (phase === 'start') {
      // item.started 的 text 通常为空；若非空也按快照处理，避免丢首段。
      emitted.set(item.id, '');
    }
    const previous = emitted.get(item.id) ?? '';
    const text = item.text ?? '';
    // 快照应当是前缀增长；CLI 重发全文但不带前缀关系时按全文补发兜底。
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (phase === 'end') emitted.delete(item.id);
    else emitted.set(item.id, text);
    return delta ? [{ type: kind, delta }] : [];
  }
}
