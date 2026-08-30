import { useCallback, useRef, useState } from 'react';
import type { ChatRequest, ChatStreamEvent } from '@waker/contracts';
import { ChatStreamError, fetchSessionMessages, streamChat } from '../lib/api.js';
import {
  createLiveTurn,
  reduceStreamEvent,
  settleLiveTools,
  type LiveTurn,
} from '../lib/stream.js';
import { newMessageId, type ChatMessage } from '../lib/types.js';
import { readThinkingPreference } from '../lib/configPanel.js';
import type { Notify } from '../components/Toasts.js';

export type ThreadState = {
  messages: ChatMessage[];
  /** true 表示历史消息已从服务端回放完成（或本次会话内产生，无需回放）。 */
  historyLoaded: boolean;
  /** 本地草稿线程：服务端 start 前新会话没有 sessionId；start 到达后迁移并清除该标记。 */
  pending?: boolean;
};

export interface ChatControllerOptions {
  /** 用户可见的错误通知。 */
  notify: Notify;
  /** 一轮对话结束后调用（刷新会话列表与收件箱）。 */
  onTurnSettled: (agentId: string) => void;
}

/** 服务端回放的 SessionMessage → 本地 ChatMessage；error/aborted 的 stopReason 映射为错误标记。 */
function toChatMessage(
  item: Awaited<ReturnType<typeof fetchSessionMessages>>[number],
): ChatMessage {
  return {
    id: item.id,
    role: item.role,
    text: item.content,
    ...(item.thinking ? { thinking: item.thinking } : {}),
    ...(item.sources?.length ? { sources: item.sources } : {}),
    ...(item.usage ? { usage: item.usage } : {}),
    ...(item.tools?.length ? { tools: item.tools } : {}),
    ...(item.stopReason === 'error' || item.stopReason === 'aborted'
      ? {
          error: item.errorMessage ?? '本轮回复失败',
          ...(item.errorKind ? { errorKind: item.errorKind } : {}),
          ...(item.errorResetAt ? { errorResetAt: item.errorResetAt } : {}),
        }
      : {}),
  };
}

/**
 * 聊天域状态编排：线程消息、历史回放、流式 turn 的中断/错误/落盘。
 * 视图切换不在此处——hook 只关心「会话 ↔ 消息」这层。
 */
export function useChatController({ notify, onTurnSettled }: ChatControllerOptions) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadState>>({});
  const [liveTurn, setLiveTurn] = useState<(LiveTurn & { messageId: string }) | null>(null);
  /** liveTurn 的同步镜像：interrupt 后同一事件循环里调 send 时读到的是最新值，不受闭包快照影响。 */
  const liveTurnRef = useRef<(LiveTurn & { messageId: string }) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** 同步更新 liveTurn 的 state 与 ref。 */
  const updateLiveTurn = (turn: (LiveTurn & { messageId: string }) | null) => {
    liveTurnRef.current = turn;
    setLiveTurn(turn);
  };

  /** 回放一个已持久化会话的历史消息；加载期间新产生的内存消息优先保留。 */
  const loadThread = useCallback(
    async (agentId: string, sessionId: string) => {
      try {
        const items = await fetchSessionMessages(agentId, sessionId);
        const messages = items.map(toChatMessage);
        setThreads((prev) => {
          const existing = prev[sessionId];
          if (existing && existing.messages.length)
            return { ...prev, [sessionId]: { ...existing, historyLoaded: true } };
          return { ...prev, [sessionId]: { messages, historyLoaded: true } };
        });
      } catch {
        // 历史读取失败：标记已处理避免反复请求，并告知用户可以重试。
        setThreads((prev) =>
          prev[sessionId]
            ? { ...prev, [sessionId]: { ...prev[sessionId]!, historyLoaded: true } }
            : prev,
        );
        notify('历史消息暂时无法读取，重新打开会话可重试', 'error');
      }
    },
    [notify],
  );

  /** 打开一个会话：设置当前 id，首次打开时占位并回放历史。 */
  const openSession = useCallback(
    (agentId: string, sessionId: string) => {
      setCurrentSessionId(sessionId);
      setThreads((prev) => {
        if (prev[sessionId]) return prev;
        void loadThread(agentId, sessionId);
        return { ...prev, [sessionId]: { messages: [], historyLoaded: false } };
      });
    },
    [loadThread],
  );

  /** 回到新建会话（welcome）状态。 */
  const closeSession = useCallback(() => setCurrentSessionId(null), []);

  const removeThread = useCallback((sessionId: string) => {
    setThreads((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setCurrentSessionId((current) => (current === sessionId ? null : current));
  }, []);

  /** 中断进行中的流式 turn（切换 Agent 或收件箱恢复动作前调用）。 */
  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    liveTurnRef.current = null;
    setLiveTurn(null);
  }, []);

  /**
   * 发起一轮对话；进行中有 turn 时直接忽略（服务端同 session 也会串行化）。
   * 显式传入 targetSessionId（如收件箱重试/继续）时跳过当前会话/草稿推导，直接落到该会话。
   */
  const send = (
    text: string,
    agentId: string,
    model?: string,
    targetSessionId?: string,
    attachmentIds?: string[],
    onSuccess?: () => void,
    projectId?: string,
    attachments?: ChatRequest['attachments'],
  ) => {
    if (liveTurnRef.current) return false;

    const userMessage: ChatMessage = { id: newMessageId(), role: 'user', text };
    const assistantMessage: ChatMessage = {
      id: newMessageId(),
      role: 'assistant',
      text: '',
      streaming: true,
    };
    // 草稿线程没有服务端 sessionId：下一轮仍按新会话发起，不能把草稿 key 发给服务端。
    const pendingKey =
      !targetSessionId && currentSessionId && threads[currentSessionId]?.pending
        ? currentSessionId
        : null;
    const sessionKey =
      targetSessionId ?? (currentSessionId && !pendingKey ? currentSessionId : null);
    const threadKey = sessionKey ?? pendingKey ?? `draft-${newMessageId()}`;

    const appendToThread = (key: string, items: ChatMessage[], pending = false) => {
      setThreads((prev) => {
        const thread = prev[key] ?? { messages: [], historyLoaded: true };
        return {
          ...prev,
          [key]: {
            ...thread,
            messages: [...thread.messages, ...items],
            historyLoaded: true,
            ...(pending ? { pending: true } : {}),
          },
        };
      });
    };

    appendToThread(threadKey, [userMessage, assistantMessage], !sessionKey);
    if (!sessionKey && !pendingKey) setCurrentSessionId(threadKey);

    const controller = new AbortController();
    abortRef.current = controller;
    // 本轮的可变进度收敛到一个对象：turn 由 reduceStreamEvent 折叠，sessionId 在 start 后确定。
    const progress = { turn: createLiveTurn(), sessionId: sessionKey as string | null };
    updateLiveTurn({ ...progress.turn, messageId: assistantMessage.id });

    /** 把已确定的回答/错误落进线程消息；读取调用时刻的最新 progress。 */
    const finalize = (
      answer: string,
      error: string | undefined,
      interrupted = false,
      errorKind?: ChatMessage['errorKind'],
      errorResetAt?: string,
    ) => {
      progress.turn = settleLiveTools(
        progress.turn,
        interrupted ? 'cancelled' : error ? 'failed' : 'completed',
      );
      const key = progress.sessionId ?? threadKey;
      setThreads((prev) => {
        const thread = prev[key];
        if (!thread) return prev;
        return {
          ...prev,
          [key]: {
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    text: answer,
                    thinking: progress.turn.thinking || undefined,
                    streaming: false,
                    error,
                    ...(errorKind ? { errorKind } : {}),
                    ...(errorResetAt ? { errorResetAt } : {}),
                    ...(interrupted ? { interrupted: true } : {}),
                    ...(progress.turn.tools.length ? { tools: progress.turn.tools } : {}),
                    ...(progress.turn.sources.length ? { sources: progress.turn.sources } : {}),
                    model: progress.turn.model,
                    usage: progress.turn.usage,
                  }
                : message,
            ),
          },
        };
      });
    };

    const onEvent = (event: ChatStreamEvent) => {
      progress.turn = reduceStreamEvent(progress.turn, event);
      if (event.type === 'start' && !progress.sessionId) {
        progress.sessionId = event.sessionId;
        setCurrentSessionId(event.sessionId);
        // 草稿线程整体迁移到服务端 session id；草稿中途被移除时退回直接落消息。
        setThreads((prev) => {
          const draft = prev[threadKey];
          const next = { ...prev };
          if (threadKey !== event.sessionId) delete next[threadKey];
          next[event.sessionId] = {
            messages: draft ? draft.messages : [userMessage, assistantMessage],
            historyLoaded: true,
          };
          return next;
        });
      }
      updateLiveTurn({ ...progress.turn, messageId: assistantMessage.id });
    };

    // 请求参数在事件到达前同步求值，此处 progress.sessionId 即 sessionKey。
    // thinking 仅在用户显式选择级别时下发；未设置时服务端用默认级别。
    const thinking = readThinkingPreference(agentId);
    streamChat(
      {
        agentId,
        message: text,
        ...(thinking ? { thinking } : {}),
        ...(sessionKey ? { sessionId: sessionKey } : {}),
        ...(model ? { model } : {}),
        ...(attachmentIds?.length ? { attachmentIds } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(projectId ? { projectId } : {}),
      },
      onEvent,
      controller.signal,
    )
      .then((done) => {
        finalize(progress.turn.answer || done.answer, undefined);
        onSuccess?.();
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) {
          finalize(progress.turn.answer, undefined, true);
          return;
        }
        const message = error.message || '流式响应失败';
        const streamError = error instanceof ChatStreamError ? error : undefined;
        finalize(
          progress.turn.answer,
          message,
          false,
          streamError?.kind,
          streamError?.resetAt,
        );
        if (progress.sessionId) {
          // 流中途断开时服务端 JSONL 可能已持久化更多内容：回放一次把线程与服务端对齐
          // （服务端持久化的 stopReason 会带出 error 标记）；重放失败则静默降级维持现状。
          const sessionId = progress.sessionId;
          void fetchSessionMessages(agentId, sessionId)
            .then((items) => {
              const messages = items.map(toChatMessage);
              setThreads((prev) => {
                const thread = prev[sessionId];
                // 服务端落盘比本地还少时保留本地错误现场，不用旧数据覆盖。
                if (!thread || messages.length < thread.messages.length) return prev;
                return { ...prev, [sessionId]: { ...thread, messages, historyLoaded: true } };
              });
            })
            .catch(() => undefined);
        } else {
          // start 之前的失败此前会被静默丢弃：草稿线程落错误消息之外再 toast 一次。
          notify(message, 'error');
        }
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        // 只清自己的 liveTurn：interrupt 后同一事件循环里可能已发起新一轮（如收件箱恢复动作），不能误清。
        if (liveTurnRef.current?.messageId === assistantMessage.id) updateLiveTurn(null);
        onTurnSettled(agentId);
      });
    return true;
  };

  /** 当前线程的渲染消息：把 liveTurn 的增量叠加到对应的 assistant 消息上。 */
  const threadMessages: ChatMessage[] = (() => {
    if (!currentSessionId) return [];
    const base = threads[currentSessionId]?.messages ?? [];
    if (!liveTurn) return base;
    return base.map((message) =>
      message.id === liveTurn.messageId
        ? {
            ...message,
            text: liveTurn.answer,
            thinking: liveTurn.thinking || undefined,
            streaming: true,
            ...(liveTurn.tools.length ? { tools: liveTurn.tools } : {}),
            ...(liveTurn.sources.length ? { sources: liveTurn.sources } : {}),
          }
        : message,
    );
  })();

  return {
    currentSessionId,
    liveTurn,
    threadMessages,
    openSession,
    closeSession,
    removeThread,
    interrupt,
    send,
  };
}
