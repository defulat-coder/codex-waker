export function readableErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof TypeError
    ? fallback
    : cause instanceof Error
      ? cause.message
      : fallback;
}
