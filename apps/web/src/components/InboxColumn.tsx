import { useState } from 'react';
import type { SessionSummary } from '@waker/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { CaretLeft } from '@phosphor-icons/react/dist/icons/CaretLeft';
import { List } from '@phosphor-icons/react/dist/icons/List';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { Tray } from '@phosphor-icons/react/dist/icons/Tray';
import { Warning } from '@phosphor-icons/react/dist/icons/Warning';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { filterAttention, groupSessions } from '../lib/sessions.js';

export type SessionFilter = 'all' | 'attention';

export type InboxColumnProps = {
  /** 列标题：当前 Agent 名，未选择时显示「会话」。 */
  title: string;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  /** 有进行中 turn 的会话 id；该会话行显示运行中脉冲点。 */
  runningSessionId?: string | null;
  filter: SessionFilter;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onFilterChange: (filter: SessionFilter) => void;
};

function SessionRow({
  session,
  active,
  running,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  running?: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  if (editing) {
    const commit = () => {
      const title = draft.trim();
      setEditing(false);
      if (title && title !== session.title) onRename(title);
      else setDraft(session.title);
    };
    return (
      <div className={cx('session-row', active && 'active')}>
        <input
          className="session-rename-input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') {
              setDraft(session.title);
              setEditing(false);
            }
          }}
          aria-label="重命名会话"
        />
      </div>
    );
  }

  return (
    <motion.div
      role="button"
      tabIndex={0}
      className={cx('session-row', active && 'active')}
      exit={{ opacity: 0, x: -8 }}
      transition={{ duration: 0.15, ease: MOTION_EASE }}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect();
      }}
      title={session.title}
    >
      <span className="session-title">{session.title}</span>
      {running && (
        <span className="session-busy" role="status" aria-label="运行中" title="运行中" />
      )}
      <span className="session-count">{session.questionCount} 问</span>
      <span className="session-row-actions">
        <button
          type="button"
          className="mini-button"
          aria-label="重命名会话"
          onClick={(event) => {
            event.stopPropagation();
            setDraft(session.title);
            setEditing(true);
          }}
        >
          <PencilSimple size={12} />
        </button>
        <button
          type="button"
          className="mini-button"
          aria-label="删除会话"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash size={12} />
        </button>
      </span>
    </motion.div>
  );
}

/** Fleet 的会话收件箱列：聊天区左侧的会话列表，可收起为单按钮。 */
export function InboxColumn(props: InboxColumnProps) {
  const { sessions, currentSessionId, filter, collapsed } = props;

  if (collapsed) {
    return (
      <aside
        className="inbox-column collapsed"
        aria-label="会话列表"
        data-mobile-presentation="trigger"
      >
        <button
          type="button"
          className="icon-button"
          onClick={props.onToggleCollapsed}
          aria-label="展开会话列表"
          title="展开会话列表"
        >
          <List size={16} />
        </button>
      </aside>
    );
  }

  const filteredSessions = filter === 'attention' ? filterAttention(sessions) : sessions;
  const groups = groupSessions(filteredSessions, new Date());
  const attentionCount = filterAttention(sessions).length;

  return (
    <aside className="inbox-column" aria-label="会话列表" data-mobile-presentation="drawer">
      <div className="inbox-column-header">
        <h3>{props.title}</h3>
        <button
          type="button"
          className="icon-button"
          onClick={props.onToggleCollapsed}
          aria-label="收起会话列表"
          title="收起会话列表"
        >
          <CaretLeft size={14} />
        </button>
      </div>

      <div className="session-tabs" role="tablist" aria-label="会话过滤">
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'all'}
          className={cx('session-tab', filter === 'all' && 'active')}
          onClick={() => props.onFilterChange('all')}
        >
          全部
          <span className="session-tab-count">({sessions.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'attention'}
          className={cx('session-tab', filter === 'attention' && 'active')}
          onClick={() => props.onFilterChange('attention')}
        >
          <Warning size={12} aria-hidden="true" />
          需处理
          <span className="session-tab-count">({attentionCount})</span>
        </button>
      </div>

      <div className="inbox-column-scroll">
        {groups.map((group) => (
          <div key={group.key}>
            <p className="session-group-label">{group.label}</p>
            <AnimatePresence initial={false}>
              {group.items.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === currentSessionId}
                  running={session.id === props.runningSessionId}
                  onSelect={() => props.onSelectSession(session.id)}
                  onRename={(title) => props.onRenameSession(session.id, title)}
                  onDelete={() => props.onDeleteSession(session.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        ))}
        {!filteredSessions.length && (
          <div className="inbox-column-empty">
            <Tray size={32} weight="light" aria-hidden="true" />
            <span>
              {filter === 'attention' ? '没有需要处理的会话' : '暂无会话，在右侧输入框开始'}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
