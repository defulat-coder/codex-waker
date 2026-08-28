import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { Folder } from '@phosphor-icons/react/dist/icons/Folder';
import { File } from '@phosphor-icons/react/dist/icons/File';
import { ArrowLeft } from '@phosphor-icons/react/dist/icons/ArrowLeft';
import { ArrowUp } from '@phosphor-icons/react/dist/icons/ArrowUp';
import type { FileContentResponse } from '@waker/contracts';
import { fetchFileContent, fetchFiles } from '../lib/api.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useWorkspace } from '../context/WorkspaceContext.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 右侧 360px 只读文件面板（Fleet Files 的本地语义：浏览仓库文件）。
 * 目录列表 → 点击目录下钻、点击文件切换为内容预览（返回键回到列表）。
 */
export function FilesPanel({ onClose }: { onClose: () => void }) {
  const { notify } = useWorkspace();
  /** 当前目录（相对仓库根，空串为根）。 */
  const [path, setPath] = useState('');
  const [search, setSearch] = useState('');
  const listing = useAsyncData(() => fetchFiles(path), {
    onError: (cause) => notify(cause.message),
  });
  /** 非 null 即内容预览态。 */
  const [file, setFile] = useState<FileContentResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const { reload } = listing;
  useEffect(() => {
    setSearch('');
    setFile(null);
    void reload();
    // reload 身份稳定（fetcher 走 ref），只需跟随 path 重拉。
  }, [path, reload]);

  const openFile = async (filePath: string) => {
    if (fileLoading) return;
    setFileLoading(true);
    try {
      setFile(await fetchFileContent(filePath));
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '文件内容暂时无法读取');
    } finally {
      setFileLoading(false);
    }
  };

  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const entries = (listing.data?.entries ?? []).filter((entry) =>
    entry.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <motion.aside
      role="complementary"
      aria-label="文件"
      className="files-panel"
      initial={{ width: 0 }}
      animate={{ width: 360 }}
      exit={{ width: 0 }}
      transition={{ duration: 0.2, ease: MOTION_EASE }}
    >
      <div className="files-panel-frame">
        <div className="files-panel-header">
          <span className="files-panel-title">文件</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭文件面板">
            <X size={16} />
          </button>
        </div>
        {file ? (
          <>
            <div className="files-panel-bar">
              <button
                type="button"
                className="icon-button"
                onClick={() => setFile(null)}
                aria-label="返回文件列表"
              >
                <ArrowLeft size={14} />
              </button>
              <span className="files-panel-path" title={file.path}>
                {file.path}
              </span>
            </div>
            <div className="files-panel-body">
              <pre className="files-panel-content">{file.content}</pre>
              {file.truncated && (
                <p className="files-panel-truncated">内容已截断（仅显示前 256KB）</p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="files-panel-bar">
              <MagnifyingGlass size={14} className="files-panel-search-icon" />
              <input
                className="files-panel-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索文件"
                aria-label="搜索文件"
              />
            </div>
            <div className="files-panel-bar">
              {path !== '' && (
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setPath(parentPath)}
                  aria-label="返回上一级"
                >
                  <ArrowUp size={14} />
                </button>
              )}
              <span className="files-panel-path" title={path || undefined}>
                {path || '项目根目录'}
              </span>
            </div>
            <div className="files-panel-body">
              {!listing.data && <p className="files-panel-loading">正在读取文件列表…</p>}
              {listing.data && listing.data.entries.length === 0 && (
                <div className="files-panel-empty">
                  <Folder size={32} />
                  <span>文件夹为空</span>
                </div>
              )}
              {listing.data && listing.data.entries.length > 0 && entries.length === 0 && (
                <p className="files-panel-loading">没有匹配「{search.trim()}」的文件</p>
              )}
              {entries.map((entry) => (
                <button
                  type="button"
                  key={entry.name}
                  className="files-panel-row"
                  onClick={() =>
                    entry.kind === 'directory'
                      ? setPath(path ? `${path}/${entry.name}` : entry.name)
                      : void openFile(path ? `${path}/${entry.name}` : entry.name)
                  }
                >
                  {entry.kind === 'directory' ? (
                    <Folder size={14} className="files-panel-row-icon" />
                  ) : (
                    <File size={14} className="files-panel-row-icon" />
                  )}
                  <span className="files-panel-row-name">{entry.name}</span>
                  {entry.kind === 'file' && (
                    <span className="files-panel-row-size">{formatSize(entry.size)}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </motion.aside>
  );
}
