/** 拼接 className：跳过 falsy 片段，保持与三元拼接相同的输出。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
