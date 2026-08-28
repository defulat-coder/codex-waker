import type { ChatCitationSource } from '@waker/contracts';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { FolderOpen } from '@phosphor-icons/react/dist/icons/FolderOpen';

const SCORE_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });

const MODE_LABELS: Record<ChatCitationSource['matchMode'], string> = {
  keyword: '关键词',
  vector: '向量',
  hybrid: '混合',
  keyword_fallback: '关键词回退',
};

export function citationSourceId(scope: string, index: number): string {
  return `citation-${scope.replace(/[^A-Za-z0-9_-]/g, '')}-${index}`;
}

/** Keeps useful provenance visible without rendering a host absolute path. */
export function safeCitationLocation(source: ChatCitationSource): string {
  const raw = source.uri?.trim();
  if (!raw) return source.title;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const tail = url.pathname.split('/').filter(Boolean).at(-1);
      return `${url.hostname}${tail ? `/${decodeURIComponent(tail)}` : ''}`;
    } catch {
      return source.title;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && !/^file:/i.test(raw)) return source.title;
  const normalized = raw.replace(/^file:\/\//i, '').replaceAll('\\', '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.' && part !== '..');
  if (!parts.length) return source.title;
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) || /^file:/i.test(raw))
    return parts.at(-1)!;
  return parts.slice(-2).join('/');
}

export function CitationSources({
  sources = [],
  citationScope = 'message',
  onOpenOutputs,
}: {
  sources?: ChatCitationSource[];
  citationScope?: string;
  onOpenOutputs?: () => void;
}) {
  if (!sources.length && !onOpenOutputs) return null;
  return (
    <div className="message-provenance">
      {sources.length > 0 && (
        <details className="citation-sources">
          <summary>
            <span>{sources.length} 个知识来源</span>
            <CaretRight size={12} className="caret" aria-hidden="true" />
          </summary>
          <ol>
            {sources.map((source) => (
              <li
                key={`${source.documentId}:${source.chunkId}:${source.index}`}
                id={citationSourceId(citationScope, source.index)}
                className="citation-source-item"
                tabIndex={-1}
              >
                <span className="citation-marker" aria-label={`来源 ${source.index}`}>
                  [{source.index}]
                </span>
                <span className="citation-source-body">
                  <span className="citation-source-heading">
                    <strong>{source.title}</strong>
                    <code>
                      {safeCitationLocation(source)}#L{source.startLine}-L{source.endLine}
                    </code>
                  </span>
                  <span className="citation-source-meta">
                    {MODE_LABELS[source.matchMode]} · 相关度 {SCORE_FORMAT.format(source.score)} ·
                    文档 v{source.documentVersion}
                  </span>
                  <span className="citation-source-ids">
                    notebook {source.notebookId} · document {source.documentId} · chunk{' '}
                    {source.chunkId}
                  </span>
                  <blockquote>{source.excerpt}</blockquote>
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {onOpenOutputs && (
        <button type="button" className="message-outputs-link" onClick={onOpenOutputs}>
          <FolderOpen size={14} aria-hidden="true" />
          查看附件与结果
        </button>
      )}
    </div>
  );
}
