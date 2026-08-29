import type { ChatErrorKind } from '@waker/contracts';

export interface ClassifiedTurnError {
  kind: ChatErrorKind;
  /** Quota reset hint extracted from the provider message (ISO-like timestamp), when present. */
  resetAt?: string;
}

/**
 * 数字错误码匹配：按独立 token 匹配（前后非数字），避免 401 命中 10401、
 * 110 命中 1105 之类的子串误报。
 */
function containsCode(text: string, code: string): boolean {
  return new RegExp(`(?:^|\\D)${code}(?:\\D|$)`).test(text);
}

const QUOTA_CODES = ['110', '112', '113', '115', '116', '117', '118', '119'] as const;

/** ISO-like datetime（quota 重置时间提示的尽力提取）。 */
const RESET_AT_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

/**
 * QoderWake 0.4.2 红卡分类的本地移植：按错误码/关键字（小写匹配）把一次失败的
 * turn 归入 quota / rate_limit / auth / timeout / network / startup / generic。
 * 匹配顺序即优先级（quota 先于 rate_limit，先于 auth），命中第一条规则即返回。
 */
export function classifyTurnError(input: { code?: string; message: string }): ClassifiedTurnError {
  if (input.code === 'CODEX_RUN_STREAM_START_FAILED') return { kind: 'startup' };

  const text = `${input.code ?? ''}\n${input.message}`.toLowerCase();

  if (
    text.includes('quota.exceeded') ||
    text.includes('quota') ||
    QUOTA_CODES.some((code) => containsCode(text, code))
  ) {
    const resetAt = RESET_AT_PATTERN.exec(input.message)?.[0];
    return { kind: 'quota', ...(resetAt ? { resetAt } : {}) };
  }
  if (text.includes('rate limit') || containsCode(text, '429') || containsCode(text, '10605')) {
    return { kind: 'rate_limit' };
  }
  if (
    text.includes('unauthorized') ||
    containsCode(text, '401') ||
    text.includes('auth expired') ||
    text.includes('login') ||
    containsCode(text, '10401')
  ) {
    return { kind: 'auth' };
  }
  if (text.includes('timeout') || text.includes('timed out') || containsCode(text, '408')) {
    return { kind: 'timeout' };
  }
  if (
    text.includes('unable to connect') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('socket')
  ) {
    return { kind: 'network' };
  }
  return { kind: 'generic' };
}
