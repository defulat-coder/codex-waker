import type { ChatCitationSource, ChatProcess, ChatUsage, SessionMessage } from '@waker/contracts';

/**
 * Codex CLI rollout files ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl)
 * are an internal, undocumented format: one JSON record per line, shaped like
 * `{ timestamp, type, payload }`. Known record types:
 * - `session_meta` / `turn_context` / `compact`: metadata, no chat content.
 * - `response_item`: a Responses-API item; `payload.type === 'message'` carries
 *   user/assistant text, `payload.type === 'reasoning'` carries thinking summaries.
 * - `event_msg`: CLI events; `token_count` reports usage, `error` / `turn_aborted`
 *   mark failed or interrupted turns.
 * Everything here is parsed defensively: unknown line shapes are skipped and a
 * malformed line never fails the parse.
 */

interface RolloutRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Concatenates text blocks of a Responses-API message content array (or a plain string). */
function textFromContent(content: unknown, blockTypes: readonly string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Record<string, unknown> => {
      const record = asRecord(block);
      return Boolean(
        record && blockTypes.includes(String(record.type)) && typeof record.text === 'string',
      );
    })
    .map((block) => block.text as string)
    .join('');
}

/** Reasoning items carry `summary` (summary_text blocks) and sometimes `content`. */
function reasoningText(payload: Record<string, unknown>): string {
  const summary = textFromContent(payload.summary, ['summary_text', 'text']);
  const content = textFromContent(payload.content, ['text', 'reasoning_text']);
  return [summary, content].filter(Boolean).join('\n');
}

/** Hides host-injected persona/retrieval wrappers when replaying the user's original text. */
function visibleUserText(text: string): string {
  // Codex materializes local_image inputs as an input_text marker containing the host path,
  // followed by an input_image block and a closing marker. It is transport metadata, not user
  // copy, and must never leak into session titles, previews, or replayed messages.
  let visible = text.replace(/<image\b[^>]*>\s*<\/image>/gi, '').trim();
  const hostWrapper =
    /^<developer-instructions(?: data-waker-host="(?:project|attachment|knowledge)-v1")?>/;
  while (hostWrapper.test(visible)) {
    const end = visible.indexOf('</developer-instructions>');
    if (end < 0) break;
    visible = visible.slice(end + '</developer-instructions>'.length).trim();
  }
  const encoded = visible.match(/^<user-query encoding="xml">\s*([\s\S]*?)\s*<\/user-query>$/)?.[1];
  if (encoded !== undefined)
    return encoded.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').trim();
  const legacy = visible.match(/^<user-query>\s*([\s\S]*?)\s*<\/user-query>$/);
  return legacy?.[1]?.trim() ?? visible;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function safeSourceTitle(value: unknown): string | undefined {
  const text = boundedText(value, 240);
  if (!text) return undefined;
  const clean = [...text]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
  if (!clean.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(clean) && !/^file:/i.test(clean))
    return clean;
  return clean
    .replace(/^file:\/\//i, '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .at(-1);
}

function safeSourceUri(value: unknown): string | undefined {
  const raw = boundedText(value, 2_000);
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return undefined;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && !/^file:/i.test(raw)) return undefined;
  const parts = raw
    .replace(/^file:\/\//i, '')
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.');
  if (!parts.length) return undefined;
  if (
    raw.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    /^file:/i.test(raw) ||
    parts.includes('..')
  )
    return parts.at(-1);
  return parts.join('/');
}

/** Validates and re-sanitizes SQLite sidecar data before it reaches browser contracts. */
export function sanitizeCitationSources(value: unknown): ChatCitationSource[] {
  if (!Array.isArray(value)) return [];
  const sources: ChatCitationSource[] = [];
  for (const entry of value.slice(0, 20)) {
    const source = asRecord(entry);
    if (!source) continue;
    const notebookId = boundedText(source.notebookId, 240);
    const documentId = boundedText(source.documentId, 240);
    const chunkId = boundedText(source.chunkId, 240);
    const title = safeSourceTitle(source.title);
    const excerpt = boundedText(source.excerpt, 240);
    const index = source.index;
    const documentVersion = source.documentVersion;
    const startLine = source.startLine;
    const endLine = source.endLine;
    const score = source.score;
    const keywordScore = source.keywordScore;
    const vectorScore = source.vectorScore;
    if (
      !notebookId ||
      !documentId ||
      !chunkId ||
      !title ||
      !excerpt ||
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 1 ||
      typeof documentVersion !== 'number' ||
      !Number.isSafeInteger(documentVersion) ||
      documentVersion < 1 ||
      typeof startLine !== 'number' ||
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      typeof endLine !== 'number' ||
      !Number.isSafeInteger(endLine) ||
      endLine < startLine ||
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      (keywordScore !== undefined &&
        (typeof keywordScore !== 'number' || !Number.isFinite(keywordScore))) ||
      (vectorScore !== undefined &&
        (typeof vectorScore !== 'number' || !Number.isFinite(vectorScore))) ||
      (source.matchMode !== 'keyword' &&
        source.matchMode !== 'vector' &&
        source.matchMode !== 'hybrid' &&
        source.matchMode !== 'keyword_fallback')
    )
      continue;
    const uri = safeSourceUri(source.uri);
    sources.push({
      index,
      notebookId,
      documentId,
      documentVersion,
      chunkId,
      title,
      ...(uri ? { uri } : {}),
      startLine,
      endLine,
      excerpt,
      matchMode: source.matchMode,
      score,
      ...(keywordScore === undefined ? {} : { keywordScore }),
      ...(vectorScore === undefined ? {} : { vectorScore }),
    });
  }
  return sources;
}

const PROCESS_PAYLOAD_LIMIT = 4 * 1024;

function visibleProcessText(text: string, privateRoots: readonly string[]): string {
  const visible = privateRoots
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((result, root) => result.split(root).join('.'), text);
  return visible.length > PROCESS_PAYLOAD_LIMIT
    ? `${visible.slice(0, PROCESS_PAYLOAD_LIMIT)}…[truncated]`
    : visible;
}

function processJson(value: unknown, privateRoots: readonly string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return visibleProcessText(JSON.stringify(value), privateRoots);
  } catch {
    return visibleProcessText(String(value), privateRoots);
  }
}

function processFromCompletedItem(
  item: Record<string, unknown>,
  privateRoots: readonly string[],
): ChatProcess | undefined {
  const id = typeof item.id === 'string' ? item.id : undefined;
  if (!id) return undefined;
  const type = String(item.type ?? '')
    .replaceAll('_', '')
    .toLowerCase();
  if (type === 'commandexecution') {
    const command = Array.isArray(item.command)
      ? item.command.map(String).filter(Boolean).at(-1)
      : typeof item.command === 'string'
        ? item.command
        : '';
    const failed =
      item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
    const result = [item.aggregated_output, item.formatted_output, item.stdout].find(
      (value): value is string => typeof value === 'string',
    );
    return {
      id,
      name: 'command_execution',
      ...(command ? { args: processJson({ command }, privateRoots) } : {}),
      ...(result !== undefined ? { result: visibleProcessText(result, privateRoots) } : {}),
      status: failed ? 'failed' : 'completed',
    };
  }
  if (type === 'filechange') {
    return {
      id,
      name: 'file_change',
      ...(Array.isArray(item.changes)
        ? { args: processJson({ changes: item.changes }, privateRoots) }
        : {}),
      ...(typeof item.status === 'string' ? { result: item.status } : {}),
      status: item.status === 'failed' ? 'failed' : 'completed',
    };
  }
  if (type === 'mcptoolcall') {
    const server = typeof item.server === 'string' ? item.server : 'mcp';
    const tool = typeof item.tool === 'string' ? item.tool : 'tool';
    const failed = item.status === 'failed' || item.error !== undefined;
    return {
      id,
      name: `${server}.${tool}`,
      ...(item.arguments !== undefined ? { args: processJson(item.arguments, privateRoots) } : {}),
      ...(item.error !== undefined || item.result !== undefined
        ? { result: processJson(item.error ?? item.result, privateRoots) }
        : {}),
      status: failed ? 'failed' : 'completed',
    };
  }
  if (type === 'todolist') {
    return {
      id,
      name: 'plan',
      ...(Array.isArray(item.items)
        ? { args: processJson({ items: item.items }, privateRoots) }
        : {}),
      status: 'completed',
    };
  }
  return undefined;
}

function usageFromTokenCount(info: unknown): ChatUsage | undefined {
  const record = asRecord(info);
  const usage = asRecord(record?.total_token_usage) ?? record;
  const input = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
  const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;
  if (input === undefined || output === undefined) return undefined;
  const total = typeof usage?.total_tokens === 'number' ? usage.total_tokens : input + output;
  return total > 0 ? { input, output, total } : undefined;
}

/**
 * Parses a rollout JSONL file into the replay contract. User and assistant
 * messages keep file order; reasoning summaries attach to the next assistant
 * message of the same turn; a trailing `error` / `turn_aborted` event marks the
 * current turn's assistant message (or synthesizes an empty one) with the stopReason.
 */
export function parseRolloutMessages(content: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  let pendingThinking = '';
  let pendingUsage: ChatUsage | undefined;
  let pendingTools: ChatProcess[] = [];
  let privateRoots: string[] = [];
  let counter = 0;

  const timestampOf = (record: RolloutRecord): string =>
    typeof record.timestamp === 'string' ? record.timestamp : '';
  const nextId = (): string => `rollout_${(counter += 1)}`;
  /** 当前 turn（最后一条 user 之后）的 assistant；turn 边界前的消息不属于本 turn。 */
  const currentTurnAssistant = (): SessionMessage | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === 'user') return undefined;
      if (message.role === 'assistant') return message;
    }
    return undefined;
  };
  const upsertTool = (tool: ChatProcess) => {
    const index = pendingTools.findIndex((entry) => entry.id === tool.id);
    if (index >= 0) pendingTools[index] = { ...pendingTools[index], ...tool };
    else pendingTools.push(tool);
  };
  const attachPendingTools = (target: SessionMessage) => {
    if (pendingTools.length) target.tools = pendingTools;
    pendingTools = [];
  };
  /** 出错/中断标记落在本 turn 的 assistant 上；turn 没产出消息时补一条空消息占位。 */
  const markStopped = (stopReason: 'error' | 'aborted', errorMessage?: string) => {
    pendingTools = pendingTools.map((tool) =>
      tool.status === 'running'
        ? { ...tool, status: stopReason === 'aborted' ? 'cancelled' : 'failed' }
        : tool,
    );
    let target = currentTurnAssistant();
    if (!target) {
      target = { id: nextId(), role: 'assistant', content: '', timestamp: '' };
      messages.push(target);
    }
    if (pendingThinking) target.thinking = pendingThinking;
    if (pendingUsage) target.usage = pendingUsage;
    attachPendingTools(target);
    pendingThinking = '';
    pendingUsage = undefined;
    target.stopReason = stopReason;
    if (errorMessage) target.errorMessage = errorMessage;
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
    const payload = asRecord(record.payload);
    if (!payload) continue;

    if (record.type === 'session_meta') {
      if (typeof payload.cwd === 'string') privateRoots = [payload.cwd];
      continue;
    }

    if (record.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role === 'user') {
        const previous = currentTurnAssistant();
        if (previous) attachPendingTools(previous);
        else pendingTools = [];
        pendingThinking = '';
        pendingUsage = undefined;
        const rawContent = textFromContent(payload.content, ['input_text', 'text']);
        const content = visibleUserText(rawContent);
        // Codex CLI materializes AGENTS.md/environment bootstrap as a synthetic user item.
        // It is runtime context, not a question, and must not become a session title/message.
        if (content.startsWith('# AGENTS.md instructions for ')) continue;
        messages.push({
          id: nextId(),
          role: 'user',
          content,
          timestamp: timestampOf(record),
        });
      } else if (role === 'assistant') {
        const message: SessionMessage = {
          id: nextId(),
          role: 'assistant',
          content: textFromContent(payload.content, ['output_text', 'text']),
          timestamp: timestampOf(record),
        };
        if (pendingThinking) message.thinking = pendingThinking;
        if (pendingUsage) message.usage = pendingUsage;
        messages.push(message);
        attachPendingTools(message);
        pendingThinking = '';
        pendingUsage = undefined;
      }
      continue;
    }

    if (record.type === 'response_item' && payload.type === 'reasoning') {
      const text = reasoningText(payload);
      if (text) pendingThinking = pendingThinking ? `${pendingThinking}\n${text}` : text;
      continue;
    }

    if (record.type === 'response_item' && payload.type === 'function_call') {
      const id =
        typeof payload.call_id === 'string'
          ? payload.call_id
          : typeof payload.id === 'string'
            ? payload.id
            : undefined;
      if (id) {
        const rawName = typeof payload.name === 'string' ? payload.name : 'tool';
        upsertTool({
          id,
          name: rawName === 'exec_command' ? 'command_execution' : rawName,
          ...(typeof payload.arguments === 'string'
            ? { args: visibleProcessText(payload.arguments, privateRoots) }
            : {}),
          status: 'running',
        });
      }
      continue;
    }

    if (record.type === 'response_item' && payload.type === 'function_call_output') {
      const id = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      if (id) {
        const current = pendingTools.find((tool) => tool.id === id);
        upsertTool({
          id,
          name: current?.name ?? 'tool',
          ...(current?.args ? { args: current.args } : {}),
          ...(typeof payload.output === 'string'
            ? { result: visibleProcessText(payload.output, privateRoots) }
            : {}),
          status: 'completed',
        });
      }
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'item_completed') {
        const item = asRecord(payload.item);
        const tool = item ? processFromCompletedItem(item, privateRoots) : undefined;
        if (tool) upsertTool(tool);
      } else if (payload.type === 'token_count') {
        const usage = usageFromTokenCount(payload.info ?? payload);
        if (usage) {
          const target = currentTurnAssistant();
          // token_count 一般在 assistant 消息之后；尚未有消息时暂存给下一条。
          if (target) target.usage = usage;
          else pendingUsage = usage;
        }
      } else if (payload.type === 'error') {
        markStopped('error', typeof payload.message === 'string' ? payload.message : undefined);
      } else if (payload.type === 'turn_aborted') {
        markStopped('aborted');
      }
      continue;
    }
    // session_meta / turn_context / compact 及其它未知类型：无聊天内容，跳过。
  }

  return messages;
}
