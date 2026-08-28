import type { KnowledgeDocument } from '@waker/contracts';

export const MAX_KNOWLEDGE_FILE_BYTES = 2_000_000;
export const MAX_KNOWLEDGE_IMPORT_FILES = 20;

export type PreparedKnowledgeFile = {
  fileName: string;
  title: string;
  content: string;
  mimeType: string;
  sourceType: KnowledgeDocument['sourceType'];
};

export type RejectedKnowledgeFile = { fileName: string; reason: string };

const extensionOf = (name: string) => name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? '';

export async function prepareKnowledgeFiles(files: File[]): Promise<{
  accepted: PreparedKnowledgeFile[];
  rejected: RejectedKnowledgeFile[];
}> {
  const accepted: PreparedKnowledgeFile[] = [];
  const rejected: RejectedKnowledgeFile[] = [];

  for (const [index, file] of files.entries()) {
    if (index >= MAX_KNOWLEDGE_IMPORT_FILES) {
      rejected.push({
        fileName: file.name,
        reason: `每次最多导入 ${MAX_KNOWLEDGE_IMPORT_FILES} 个文件`,
      });
      continue;
    }
    const extension = extensionOf(file.name);
    if (extension !== 'md' && extension !== 'markdown' && extension !== 'txt') {
      rejected.push({ fileName: file.name, reason: '仅支持 .md、.markdown 和 .txt' });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ fileName: file.name, reason: '文件为空' });
      continue;
    }
    if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
      rejected.push({ fileName: file.name, reason: '文件超过 2 MB' });
      continue;
    }
    try {
      const content = await file.text();
      if (!content.trim()) {
        rejected.push({ fileName: file.name, reason: '文件没有可导入的文本' });
        continue;
      }
      if (content.includes('\0')) {
        rejected.push({ fileName: file.name, reason: '文件看起来不是纯文本' });
        continue;
      }
      accepted.push({
        fileName: file.name,
        title: file.name.replace(/\.(?:md|markdown|txt)$/i, '').slice(0, 240),
        content,
        mimeType: extension === 'txt' ? 'text/plain' : 'text/markdown',
        sourceType: extension === 'txt' ? 'text' : 'markdown',
      });
    } catch {
      rejected.push({ fileName: file.name, reason: '浏览器无法读取文件' });
    }
  }

  return { accepted, rejected };
}
