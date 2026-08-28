export type SessionUploadReport = {
  fileName: string;
  status: 'success' | 'error';
  message: string;
};

const MAX_UPLOAD_BATCH_FILES = 20;
const MAX_UPLOAD_BATCH_BYTES = 100 * 1024 * 1024;

export function selectSessionUploadBatch(files: File[]): {
  accepted: File[];
  rejected: SessionUploadReport[];
} {
  const accepted: File[] = [];
  const rejected: SessionUploadReport[] = [];
  let bytes = 0;
  for (const file of files) {
    if (accepted.length >= MAX_UPLOAD_BATCH_FILES) {
      rejected.push({
        fileName: file.name,
        status: 'error',
        message: `每批最多 ${MAX_UPLOAD_BATCH_FILES} 个附件`,
      });
      continue;
    }
    if (bytes + file.size > MAX_UPLOAD_BATCH_BYTES) {
      rejected.push({
        fileName: file.name,
        status: 'error',
        message: '每批附件总大小不能超过 100 MB',
      });
      continue;
    }
    bytes += file.size;
    accepted.push(file);
  }
  return { accepted, rejected };
}
