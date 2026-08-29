export const MAX_KNOWLEDGE_IMPORT_URLS = 20;

/** 从空格/换行分隔的输入里提取合法 http/https 链接（去重、保持顺序）。 */
export function parseKnowledgeUrls(input: string): string[] {
  const seen = new Set<string>();
  for (const token of input.split(/\s+/)) {
    if (!token) continue;
    try {
      const url = new URL(token);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      seen.add(url.toString());
    } catch {
      // 非链接片段直接忽略，交给计数提示用户。
    }
  }
  return [...seen];
}
