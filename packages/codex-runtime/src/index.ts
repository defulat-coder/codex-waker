import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Codex, type Input, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import type { ChatCitationSource, ChatStreamEvent, ChatUsage } from '@waker/contracts';
import { getAgent, type AgentDefinition } from './agents.js';
import {
  chatUsageFromTurnUsage,
  CodexEventNormalizer,
  redactPrivateRoots,
  type CodexThreadEvent,
  type CodexTurnUsage,
} from './events.js';
import {
  getCodexModelConfig,
  getCodexProjectRoot,
  getCodexProviderConfig,
  getCodexReasoningEffort,
  getCodexSandboxConfig,
  isCodexAgentEnabled,
  type CodexReasoningEffort,
} from './model-config.js';
import { agentSessionStoreFor, AgentSessionStore } from './session-store.js';

export * from './agents.js';
export * from './events.js';
export * from './json-store.js';
export {
  getCodexModelConfig,
  getCodexProjectRoot,
  getCodexProviderConfig,
  getCodexReasoningEffort,
  getCodexSandboxConfig,
  isCodexAgentEnabled,
  listCodexModels,
  readCodexSettings,
} from './model-config.js';
export type {
  CodexApprovalPolicy,
  CodexModelConfig,
  CodexProviderConfig,
  CodexReasoningEffort,
  CodexSandboxConfig,
  CodexSandboxMode,
} from './model-config.js';
export { parseRolloutMessages } from './rollout.js';
export * from './session-store.js';
export * from './skills.js';
export * from './templates.js';
export * from './usage.js';

export interface CodexAgentSessionOptions {
  cwd?: string;
  agentId: string;
  sessionId?: string;
  sessionDir?: string;
  /** Unit tests can opt out of workbench.sqlite persistence; Web sessions persist by default. */
  persistSession?: boolean;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  workingDirectory?: string;
}

export interface AgentTurnOptions {
  /** Per-turn thinking level selected by the Web client. */
  reasoningEffort?: CodexReasoningEffort;
  /** Per-turn model override, already validated by the API against the settings catalog. */
  model?: string;
  /** Server-validated project directory for this session/turn. */
  workingDirectory?: string;
  /** Host-trusted retrieval provenance persisted beside this user turn, never inside its text. */
  sources?: ChatCitationSource[];
  onEvent?: (event: ChatStreamEvent) => void;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

export interface AgentTurnResult {
  answer: string;
  thinkingText: string;
  usage?: ChatUsage;
}

export type AgentInput = Input;

export type CodexTurnErrorCode =
  | 'CODEX_RUN_STREAM_START_FAILED'
  | 'CODEX_TURN_FAILED'
  | 'CODEX_STREAM_ERROR'
  | 'CODEX_TURN_ABORTED';

/** Stable error classification for API callers; provider messages remain available in `message`. */
export class CodexTurnError extends Error {
  constructor(
    readonly code: CodexTurnErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodexTurnError';
  }
}

/** User/connection initiated cancellation, distinct from an ordinary provider failure. */
export class CodexTurnAbortedError extends CodexTurnError {
  constructor(options?: ErrorOptions) {
    super('CODEX_TURN_ABORTED', 'Codex turn was aborted', options);
    this.name = 'CodexTurnAbortedError';
  }
}

export interface CodexAgentSession {
  cwd: string;
  agentId: string;
  sessionId: string;
  thread: Thread;
  store: AgentSessionStore;
  /** thread.id once the CLI reported thread.started; null before the first turn. */
  threadId: string | null;
  model?: string;
  reasoningEffort: CodexReasoningEffort;
  workingDirectory: string;
  persistSession: boolean;
  /** AbortController of the in-flight turn, so abort() can cancel it (TurnOptions.signal). */
  activeTurn?: AbortController;
  close: () => void;
}

/** process.env 可能带 undefined 值；SDK 的 env 只接受 string，且给定后不再继承进程环境。 */
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Agent 人设注入：新 thread 的首个 turn 把 agent body 包成 developer-instructions
 * 前缀随用户消息一起发出（Codex Thread 没有运行期 systemPrompt 参数）；后续 turn
 * 原样发送。resumeThread 续上的会话不再重复注入。
 */
function wrapThreadWithPersona(
  thread: Thread,
  agent: AgentDefinition,
  injectOnFirstTurn: boolean,
): Thread {
  let pending = injectOnFirstTurn;
  const withPersona = (input: Input): Input => {
    if (!pending) return input;
    pending = false;
    const persona = `<developer-instructions>\n# Agent: ${agent.name}\n\n${agent.body}\n</developer-instructions>`;
    return typeof input === 'string'
      ? `${persona}\n\n${input}`
      : [{ type: 'text', text: persona }, ...input];
  };
  const wrapper = {
    get id(): string | null {
      return thread.id;
    },
    run: (input: Input, turnOptions?: Parameters<Thread['run']>[1]) =>
      thread.run(withPersona(input), turnOptions),
    runStreamed: (input: Input, turnOptions?: Parameters<Thread['runStreamed']>[1]) =>
      thread.runStreamed(withPersona(input), turnOptions),
  };
  return wrapper as unknown as Thread;
}

/**
 * Creates one Codex Thread for an agent bound to one immutable workbench session.
 * The CLI owns rollout persistence (CODEX_HOME points at the project .codex);
 * the workbench store only records the session ↔ agent ↔ threadId binding.
 * Sandbox defaults to read-only + never-approve; HITL approvals are out of scope.
 */
export async function createCodexAgentSession(
  options: CodexAgentSessionOptions,
): Promise<CodexAgentSession> {
  const cwd = options.cwd ?? getCodexProjectRoot();
  const agent = getAgent(cwd, options.agentId);
  const persistSession = options.persistSession !== false;
  // 共享 store（按 cwd+sessionDir 缓存）：每开一条会话就 new AgentSessionStore 会
  // 多开一条 sqlite 连接，且 registry 淘汰时不会释放。测试可直接 new 绕开共享。
  const store = agentSessionStoreFor({
    cwd,
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
  });

  let sessionId: string;
  let existingThreadId: string | null = null;
  if (persistSession) {
    const summary = options.sessionId
      ? await store.ensureSession(options.sessionId, agent.id)
      : await store.createSession(agent.id);
    sessionId = summary.id;
    existingThreadId = store.getEntry(sessionId, agent.id)?.threadId ?? null;
  } else {
    sessionId = options.sessionId ?? `session_${randomUUID().slice(0, 8)}`;
  }

  const { model } = getCodexModelConfig(options.model ? { model: options.model } : {}, cwd);
  const reasoningEffort = getCodexReasoningEffort(options.reasoningEffort, cwd);
  const sandbox = getCodexSandboxConfig(cwd);
  const provider = getCodexProviderConfig(cwd, model);
  const env: Record<string, string> = { ...inheritedEnv(), CODEX_HOME: join(cwd, '.codex') };
  if (provider?.envKey && !env[provider.envKey]) {
    throw new Error(`模型提供方需要 API key：请在 .env 配置 ${provider.envKey}`);
  }

  const codex = new Codex({ env, ...(provider ? { config: provider.config } : {}) });
  const workingDirectory = options.workingDirectory ?? cwd;
  const threadOptions: ThreadOptions = {
    workingDirectory,
    skipGitRepoCheck: true,
    ...(model ? { model } : {}),
    modelReasoningEffort: reasoningEffort,
    sandboxMode: sandbox.sandboxMode,
    approvalPolicy: sandbox.approvalPolicy,
  };
  // 已有绑定 threadId 的会话走 resumeThread，人设注入只发生在新 thread 上。
  const thread = existingThreadId
    ? codex.resumeThread(existingThreadId, threadOptions)
    : codex.startThread(threadOptions);

  const session: CodexAgentSession = {
    cwd,
    agentId: agent.id,
    sessionId,
    thread: wrapThreadWithPersona(thread, agent, !existingThreadId),
    store,
    get threadId(): string | null {
      return thread.id;
    },
    ...(model ? { model } : {}),
    reasoningEffort,
    workingDirectory,
    persistSession,
    // SDK 未暴露 Thread dispose；close 只取消进行中的 turn，CLI 子进程随宿主进程退出。
    close: () => {
      session.activeTurn?.abort();
    },
  };
  return session;
}

/**
 * Drives one streamed turn: SDK events flow through CodexEventNormalizer, the
 * thread.started id is persisted into the session binding, and turn failures
 * throw explicitly — never replaced by a fallback answer.
 */
async function collectTurn(
  runtime: CodexAgentSession,
  message: Input,
  options: AgentTurnOptions,
): Promise<AgentTurnResult> {
  const normalizer = new CodexEventNormalizer([runtime.cwd, runtime.workingDirectory]);
  const visibleError = (message: string): string =>
    redactPrivateRoots(message, [runtime.cwd, runtime.workingDirectory]);
  let answer = '';
  let thinkingText = '';
  let usage: ChatUsage | undefined;

  const abortController = new AbortController();
  runtime.activeTurn = abortController;
  try {
    let events: AsyncIterable<CodexThreadEvent>;
    try {
      ({ events } = (await runtime.thread.runStreamed(message, {
        signal: abortController.signal,
      })) as { events: AsyncIterable<CodexThreadEvent> });
    } catch (error) {
      if (abortController.signal.aborted) throw new CodexTurnAbortedError({ cause: error });
      throw new CodexTurnError('CODEX_RUN_STREAM_START_FAILED', visibleError(errorMessage(error)), {
        cause: error,
      });
    }
    for await (const event of events) {
      const threadEvent = event as unknown as CodexThreadEvent;
      if (threadEvent.type === 'thread.started' && runtime.persistSession) {
        await runtime.store.bindThread(runtime.sessionId, runtime.agentId, threadEvent.thread_id);
      }
      if (threadEvent.type === 'turn.completed') {
        usage = chatUsageFromTurnUsage(threadEvent.usage as CodexTurnUsage);
      } else if (threadEvent.type === 'turn.failed') {
        throw new CodexTurnError('CODEX_TURN_FAILED', visibleError(threadEvent.error.message));
      } else if (threadEvent.type === 'error') {
        throw new CodexTurnError('CODEX_STREAM_ERROR', visibleError(threadEvent.message));
      }
      for (const frame of normalizer.normalize(threadEvent)) {
        options.onEvent?.(frame);
        if (frame.type === 'text_delta') {
          answer += frame.delta;
          options.onTextDelta?.(frame.delta);
        } else if (frame.type === 'thinking_delta') {
          thinkingText += frame.delta;
          options.onThinkingDelta?.(frame.delta);
        }
      }
    }
    if (!answer.trim()) throw new CodexTurnError('CODEX_STREAM_ERROR', 'Codex 未返回可显示内容');
    return { answer: answer.trim(), thinkingText, ...(usage ? { usage } : {}) };
  } catch (error) {
    if (abortController.signal.aborted && !(error instanceof CodexTurnAbortedError))
      throw new CodexTurnAbortedError({ cause: error });
    throw error;
  } finally {
    runtime.activeTurn = undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 任务在出队前被 cancel() 取消（任务体未执行）。 */
export class KeyedTaskCancelledError extends Error {
  constructor(key: string) {
    super(`任务已取消：${key}`);
    this.name = 'KeyedTaskCancelledError';
  }
}

/** Serializes async tasks per key so one Codex thread never runs concurrent turns. */
export class KeyedExecutor {
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Queued-or-running task count per key; eviction must never touch a key with pending work. */
  private readonly inFlight = new Map<string, number>();
  /** 每个 key 的入队序号；cancel 记录取消时刻的序号，只有序号 ≤ 它（取消时已排队）的任务才被取消。 */
  private readonly sequences = new Map<string, number>();
  private readonly cancelBelow = new Map<string, number>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const sequence = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, sequence);
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    const next = (this.tails.get(key) ?? Promise.resolve()).then(() => {
      // 出队时序号落在 cancel 标记内：任务体不执行，直接以取消错误 reject。
      if ((this.cancelBelow.get(key) ?? 0) >= sequence) throw new KeyedTaskCancelledError(key);
      return task();
    });
    // The stored tail swallows rejections so one failed turn never blocks the queue.
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    const settle = () => {
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left <= 0) {
        this.inFlight.delete(key);
        this.sequences.delete(key);
        this.cancelBelow.delete(key);
        // tails 只增不减会让 map 无限增长：仅当链尾仍是自己（没有新任务排进来）才摘除。
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else {
        this.inFlight.set(key, left);
      }
    };
    void next.then(settle, settle);
    return next;
  }

  /** True while a task for this key is queued or running. */
  hasPending(key: string): boolean {
    return (this.inFlight.get(key) ?? 0) > 0;
  }

  /**
   * 取消该 key 当前已排队未开始的任务（出队时以 KeyedTaskCancelledError reject）；
   * 进行中的任务与 cancel 之后新排队的任务都不受影响。
   */
  cancel(key: string): void {
    if (!this.hasPending(key)) return;
    this.cancelBelow.set(key, this.sequences.get(key) ?? 0);
  }

  /** Resolves once every task currently queued or running for the key has settled. */
  async whenSettled(key: string): Promise<void> {
    // tail 吞掉了 reject，await 它只等时序、不上抛任务错误。
    await this.tails.get(key);
  }
}

interface RegistryEntry {
  session: Promise<CodexAgentSession>;
  lastUsedAt: number;
}

export interface CodexThreadRegistryOptions {
  /** Idle sessions older than this are evicted on the next registry operation. */
  idleTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Session factory injection for tests; production uses createCodexAgentSession. */
  createSession?: (options: CodexAgentSessionOptions) => Promise<CodexAgentSession>;
}

/** Keeps one Codex thread per agent/session pair so contexts never share a runtime. */
export class CodexThreadRegistry {
  private readonly sessions = new Map<string, RegistryEntry>();
  private readonly executor = new KeyedExecutor();
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly createSession: (options: CodexAgentSessionOptions) => Promise<CodexAgentSession>;

  constructor(options: CodexThreadRegistryOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.createSession = options.createSession ?? createCodexAgentSession;
  }

  private getOrCreate(
    agentId: string,
    sessionId: string,
    options: Omit<CodexAgentSessionOptions, 'agentId' | 'sessionId'> = {},
  ): Promise<CodexAgentSession> {
    const key = `${agentId}:${sessionId}`;
    this.sweepIdle();
    const existing = this.sessions.get(key);
    if (existing && !this.isExpired(existing)) {
      existing.lastUsedAt = this.now();
      return existing.session;
    }
    // 当前 key 的过期条目：executor 保证同 key 同一时间只有本任务在执行，淘汰安全。
    if (existing) this.evict(key, existing);
    const created = this.createSession({ ...options, agentId, sessionId, persistSession: true });
    this.sessions.set(key, { session: created, lastUsedAt: this.now() });
    // 创建失败时不能缓存 rejected Promise，否则该 session 后续所有 turn 都命中同一个
    // 失败；仅在自己仍是 map 里的条目时摘除，避免竞态误删新条目。
    created.catch(() => {
      if (this.sessions.get(key)?.session === created) this.sessions.delete(key);
    });
    return created;
  }

  private isExpired(entry: RegistryEntry): boolean {
    return this.now() - entry.lastUsedAt > this.idleTtlMs;
  }

  private evict(key: string, entry: RegistryEntry): void {
    this.sessions.delete(key);
    void entry.session.then(
      (runtime) => runtime.close(),
      () => undefined,
    );
  }

  /** Lazy sweep (no timer): evict idle-expired entries that have no queued or running turn. */
  private sweepIdle(): void {
    for (const [key, entry] of this.sessions) {
      if (!this.isExpired(entry) || this.executor.hasPending(key)) continue;
      this.evict(key, entry);
    }
  }

  async run(
    agentId: string,
    sessionId: string,
    message: Input,
    options: AgentTurnOptions = {},
    sessionOptions: Omit<CodexAgentSessionOptions, 'agentId' | 'sessionId'> = {},
  ): Promise<AgentTurnResult> {
    const key = `${agentId}:${sessionId}`;
    // Concurrent /chat turns on the same session would interleave runStreamed()
    // calls on one Codex thread; serialize them per key.
    return this.executor.run(key, async () => {
      let runtime = await this.getOrCreate(agentId, sessionId, sessionOptions);
      // model/effort 是 startThread/resumeThread 的创建期参数，Thread 上没有热切换：
      // 变更时淘汰旧条目并重建（store 里已有 threadId，新 Thread 走 resumeThread 续上）。
      const modelChanged =
        sessionOptions.model !== undefined && runtime.model !== sessionOptions.model;
      const effortChanged =
        sessionOptions.reasoningEffort !== undefined &&
        runtime.reasoningEffort !== sessionOptions.reasoningEffort;
      const workingDirectoryChanged =
        sessionOptions.workingDirectory !== undefined &&
        runtime.workingDirectory !== sessionOptions.workingDirectory;
      if (modelChanged || effortChanged || workingDirectoryChanged) {
        const entry = this.sessions.get(key);
        if (entry) this.evict(key, entry);
        runtime = await this.getOrCreate(agentId, sessionId, sessionOptions);
      }
      if (runtime.persistSession) {
        const turnIndex =
          (await runtime.store.listMessages(sessionId, agentId)).filter(
            (message) => message.role === 'user',
          ).length + 1;
        runtime.store.setTurnSources(sessionId, agentId, turnIndex, options.sources ?? []);
      }
      try {
        return await collectTurn(runtime, message, options);
      } finally {
        // A long turn must not look idle-expired the moment it finishes.
        const entry = this.sessions.get(key);
        if (entry) entry.lastUsedAt = this.now();
      }
    });
  }

  /** Runs a non-turn task (e.g. rename) after any in-flight turn of the same session. */
  runExclusive<T>(agentId: string, sessionId: string, task: () => Promise<T>): Promise<T> {
    return this.executor.run(`${agentId}:${sessionId}`, task);
  }

  /** 取消该 session 已排队的任务（出队即 reject）；进行中的 turn 由 abort/close 处理。 */
  cancelQueued(agentId: string, sessionId: string): void {
    this.executor.cancel(`${agentId}:${sessionId}`);
  }

  /** Aborts the running turn of one session (e.g. when the SSE client disconnects). */
  async abort(agentId: string, sessionId: string): Promise<void> {
    const key = `${agentId}:${sessionId}`;
    // 排队的 turn 一并取消：否则 abort 进行中 turn 后，它们仍会在 getOrCreate 里继续执行。
    this.executor.cancel(key);
    const entry = this.sessions.get(key);
    if (!entry) return;
    // entry.session 可能是创建失败的 rejected Promise（摘除的 catch 尚未执行），不能上抛。
    const runtime = await entry.session.catch(() => undefined);
    runtime?.activeTurn?.abort();
  }

  /**
   * Removes one session runtime: aborts the in-flight turn and resolves only after the
   * per-key queue has fully settled, so callers can safely delete rollout files afterwards.
   */
  async close(agentId: string, sessionId: string): Promise<void> {
    const key = `${agentId}:${sessionId}`;
    const entry = this.sessions.get(key);
    this.sessions.delete(key);
    // entry.session 可能是创建失败的 rejected Promise，直接 await 会把异常抛给路由（500）。
    const runtime = entry ? await entry.session.catch(() => undefined) : undefined;
    runtime?.close();
    // 等进行中的 turn settle（aborted）与排队任务收尾后再返回。
    await this.executor.whenSettled(key);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(entries.map(async (entry) => (await entry.session).close()));
  }
}

export const codexThreadRegistry = new CodexThreadRegistry();

/** Runs one chat turn; errors are thrown explicitly, never replaced by a fallback answer. */
export async function runAgentTurn(
  agentId: string,
  sessionId: string,
  message: Input,
  options: AgentTurnOptions = {},
): Promise<AgentTurnResult> {
  if (!isCodexAgentEnabled(process.env.CODEX_AGENT_ENABLED))
    throw new Error('Codex 模型未启用，无法开始会话');
  return codexThreadRegistry.run(agentId, sessionId, message, options, {
    ...(options.model ? { model: options.model } : {}),
    reasoningEffort: options.reasoningEffort ?? getCodexReasoningEffort(),
    ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
  });
}
