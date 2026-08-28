import type { SessionMessage } from '@waker/contracts';

/** 收件箱「恢复闭环」的两种动作：error 会话重试，aborted 会话继续。 */
export type InboxResumeMode = 'retry' | 'continue';

/** 「继续」被中断会话时发送的固定文本。 */
export const INBOX_CONTINUE_TEXT = '请继续';

/**
 * 组装恢复动作要发送的文本：
 * - continue：固定「请继续」；
 * - retry：最后一条用户消息的内容（作为新的一轮重发）；找不到时返回 null。
 */
export function buildInboxResumeText(
  messages: SessionMessage[],
  mode: InboxResumeMode,
): string | null {
  if (mode === 'continue') return INBOX_CONTINUE_TEXT;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') return message.content;
  }
  return null;
}
