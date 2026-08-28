export const MAX_TURN_ATTACHMENTS = 8;
export const MAX_TURN_ATTACHMENT_BYTES = 24 * 1024 * 1024;

export interface PreparedComposerAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  file: File;
}

export type DraftComposerAttachment = PreparedComposerAttachment & { previewUrl?: string };

export interface RejectedComposerAttachment {
  originalName: string;
  reason: string;
}

const SECRET_FILENAME =
  /(?:^|[._-])(?:\.env|env|id_rsa|id_ed25519|credentials?|secrets?|tokens?|passwords?|api[_-]?keys?)(?:$|[._-])/i;

let attachmentSequence = 0;

function inferredMimeType(file: File): string | undefined {
  const declared = file.type.trim().toLowerCase();
  if (declared) return declared;
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!extension) return undefined;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension))
    return extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  if (extension === 'json') return 'application/json';
  if (extension === 'xml') return 'application/xml';
  if (
    [
      'txt',
      'md',
      'markdown',
      'csv',
      'log',
      'js',
      'jsx',
      'ts',
      'tsx',
      'css',
      'html',
      'svg',
    ].includes(extension)
  )
    return extension === 'csv' ? 'text/csv' : 'text/plain';
  return undefined;
}

export function isTurnAttachmentMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  );
}

export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('浏览器无法读取文件'));
    reader.onload = () => {
      const encoded = String(reader.result).split(',', 2)[1];
      if (!encoded) reject(new Error('浏览器无法读取文件'));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

export async function prepareComposerAttachments(
  files: File[],
  existing: PreparedComposerAttachment[] = [],
  maxAttachments = MAX_TURN_ATTACHMENTS,
): Promise<{
  accepted: PreparedComposerAttachment[];
  rejected: RejectedComposerAttachment[];
}> {
  const rejected: RejectedComposerAttachment[] = [];
  const candidates: Array<{ file: File; mimeType: string }> = [];
  const limit = Math.max(0, Math.min(MAX_TURN_ATTACHMENTS, maxAttachments));
  let totalBytes = existing.reduce((sum, item) => sum + item.size, 0);
  const seen = new Set(
    existing.map((item) => `${item.originalName}:${item.size}:${item.file.lastModified}`),
  );

  for (const file of files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) {
      rejected.push({ originalName: file.name, reason: '同一文件已在待发送列表中' });
      continue;
    }
    if (existing.length + candidates.length >= limit) {
      rejected.push({
        originalName: file.name,
        reason: limit ? `当前轮次最多还能使用 ${limit} 个新附件` : '当前轮次没有剩余附件名额',
      });
      continue;
    }
    if (!file.name.trim() || SECRET_FILENAME.test(file.name)) {
      rejected.push({ originalName: file.name || '未命名文件', reason: '文件名可能包含敏感信息' });
      continue;
    }
    if (file.size <= 0) {
      rejected.push({ originalName: file.name, reason: '文件为空' });
      continue;
    }
    if (totalBytes + file.size > MAX_TURN_ATTACHMENT_BYTES) {
      rejected.push({ originalName: file.name, reason: '本轮附件总大小不能超过 24 MB' });
      continue;
    }
    const mimeType = inferredMimeType(file);
    if (!mimeType || !isTurnAttachmentMimeType(mimeType)) {
      rejected.push({ originalName: file.name, reason: '对话仅支持文本、JSON、XML 和图片附件' });
      continue;
    }
    seen.add(key);
    totalBytes += file.size;
    candidates.push({ file, mimeType });
  }

  const reads = await Promise.allSettled(
    candidates.map(async ({ file, mimeType }) => ({
      id: `draft-attachment-${++attachmentSequence}`,
      originalName: file.name,
      mimeType,
      size: file.size,
      dataBase64: await readFileBase64(file),
      file,
    })),
  );
  const accepted: PreparedComposerAttachment[] = [];
  reads.forEach((result, index) => {
    const file = candidates[index]!.file;
    if (result.status === 'fulfilled') accepted.push(result.value);
    else
      rejected.push({
        originalName: file.name,
        reason: result.reason instanceof Error ? result.reason.message : '浏览器无法读取文件',
      });
  });
  return { accepted, rejected };
}

export function formatAttachmentBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
