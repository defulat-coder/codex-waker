import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { InboxItem, InboxTab, SessionMessage } from '@waker/contracts';
import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise';
import { ArrowLeft } from '@phosphor-icons/react/dist/icons/ArrowLeft';
import { CheckCircle } from '@phosphor-icons/react/dist/icons/CheckCircle';
import { EnvelopeOpen } from '@phosphor-icons/react/dist/icons/EnvelopeOpen';
import { EnvelopeSimple } from '@phosphor-icons/react/dist/icons/EnvelopeSimple';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { Play } from '@phosphor-icons/react/dist/icons/Play';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { Tray } from '@phosphor-icons/react/dist/icons/Tray';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { deleteSession, fetchInbox, fetchSessionMessages, updateInboxState } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import type { InboxResumeMode } from '../lib/inboxResume.js';
import { formatRelativeTime } from '../lib/sessions.js';
import { MOTION_EASE } from '../lib/motion.js';
import type { ChatMessage } from '../lib/types.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { useWorkspace } from '../context/WorkspaceContext.js';
import { AgentChip } from './AgentChip.js';
import { ThreadView } from './ThreadView.js';

/** 搜索输入防抖：输入停顿后再真正发起过滤请求。 */
const QUERY_DEBOUNCE_MS = 250;

const TABS: Array<{ key: InboxTab; label: string; icon: typeof WarningCircle }> = [
  { key: 'attention', label: '需处理', icon: WarningCircle },
  { key: 'completed', label: '已完成', icon: CheckCircle },
  { key: 'all', label: '全部', icon: Tray },
];

const EMPTY_COPY: Record<InboxTab, { title: string; hint: string }> = {
  attention: { title: '没有需要处理的会话', hint: '运行出错或被中断的会话会出现在这里。' },
  completed: { title: '没有已完成的会话', hint: '处理完或重新运行成功的会话会进入这里。' },
  all: { title: '收件箱是空的', hint: '运行出错或被中断的会话会进入收件箱。' },
};

function attentionLabel(item: InboxItem): string {
  return item.attentionReason === 'aborted' ? '已中断' : '出错';
}

/** 仍需处理的行（未完成的出错/中断）才显示状态药丸与详情提示条。 */
function isAttention(item: InboxItem): boolean {
  return item.needsAttention && !item.completedAt;
}

function toChatMessage(message: SessionMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.content,
    thinking: message.thinking,
    tools: message.tools,
    sources: message.sources,
    error: message.stopReason === 'error' ? (message.errorMessage ?? '本轮回复失败') : undefined,
    interrupted: message.stopReason === 'aborted' || undefined,
  };
}

type RowHandlers = {
  onRead: (item: InboxItem) => void;
  onToggleRead: (item: InboxItem) => void;
  onToggleSelect: (item: InboxItem) => void;
  onDelete: (item: InboxItem) => void;
  onOpenDetail: (item: InboxItem) => void;
};

function InboxRow({
  item,
  agentName,
  agentMark,
  selected,
  now,
  handlers,
}: {
  item: InboxItem;
  agentName: string;
  agentMark: string;
  selected: boolean;
  now: Date;
  handlers: RowHandlers;
}) {
  return (
    <motion.div
      role="listitem"
      tabIndex={0}
      className={cx('inbox-row', !item.read && 'unread', selected && 'selected')}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -8, transition: { duration: 0.15, ease: MOTION_EASE } }}
      transition={{ duration: 0.2, ease: MOTION_EASE }}
      onClick={() => {
        if (!item.read) handlers.onRead(item);
      }}
      onDoubleClick={() => handlers.onOpenDetail(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') handlers.onOpenDetail(item);
      }}
      title={item.attentionDetail ?? item.title}
    >
      <AgentChip mark={agentMark} />
      <span className="inbox-agent">{agentName}</span>
      {isAttention(item) && (
        <span className="inbox-status">
          <WarningCircle size={12} weight="fill" aria-hidden="true" />
          {attentionLabel(item)}
        </span>
      )}
      <span className="inbox-title">
        <span className="inbox-title-text">{item.title}</span>
        {item.read && item.preview && <span className="inbox-preview"> — {item.preview}</span>}
      </span>
      <span className="inbox-time">{formatRelativeTime(item.updatedAt, now)}</span>
      <span
        className="inbox-row-actions"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          className="inbox-checkbox"
          checked={selected}
          onChange={() => handlers.onToggleSelect(item)}
          aria-label={`选择会话 ${item.title}`}
        />
        <button
          type="button"
          className="icon-button"
          onClick={() => handlers.onToggleRead(item)}
          aria-label={item.read ? '标记未读' : '标记已读'}
          title={item.read ? '标记未读' : '标记已读'}
        >
          {item.read ? <EnvelopeSimple size={14} /> : <EnvelopeOpen size={14} />}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => handlers.onDelete(item)}
          aria-label={`删除会话 ${item.title}`}
          title="删除"
        >
          <Trash size={14} />
        </button>
      </span>
    </motion.div>
  );
}

function InboxDetail({
  item,
  agentName,
  agentMark,
  onClose,
  onOpenChat,
  onResume,
}: {
  item: InboxItem;
  agentName: string;
  agentMark: string;
  onClose: () => void;
  onOpenChat: () => void;
  /** 恢复动作：aborted →「继续」，其余（error）→「重试」。 */
  onResume: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [messageLoadFailed, setMessageLoadFailed] = useState(false);
  const [messageLoadAttempt, setMessageLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setMessageLoadFailed(false);
    fetchSessionMessages(item.agentId, item.id)
      .then((items) => {
        if (!cancelled) setMessages(items.map(toChatMessage));
      })
      .catch(() => {
        if (!cancelled) setMessageLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.agentId, item.id, messageLoadAttempt]);

  const resumable = isAttention(item);
  const ResumeIcon = item.attentionReason === 'aborted' ? Play : ArrowClockwise;

  return (
    <>
      <div className="inbox-detail-header">
        <AgentChip mark={agentMark} />
        <span className="inbox-detail-agent">{agentName}</span>
        <span className="inbox-detail-title" title={item.title}>
          {item.title}
        </span>
        <button type="button" className="header-button" onClick={onOpenChat}>
          在聊天中打开
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="返回会话列表"
          title="返回会话列表"
        >
          <ArrowLeft size={14} />
        </button>
      </div>
      {resumable && (
        <div className="inbox-detail-banner" role="status">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          <p>{item.attentionDetail ?? `${attentionLabel(item)}，可以在聊天中继续`}</p>
          <button type="button" className="header-button primary" onClick={onResume}>
            <ResumeIcon size={13} weight="bold" />
            {item.attentionReason === 'aborted' ? '继续' : '重试'}
          </button>
          <button type="button" className="header-button" onClick={onOpenChat}>
            在聊天中打开继续
          </button>
        </div>
      )}
      {messageLoadFailed ? (
        <div className="inbox-detail-error" role="alert">
          <WarningCircle size={16} weight="fill" aria-hidden="true" />
          <p>会话消息暂时无法读取。</p>
          <button
            type="button"
            className="header-button"
            onClick={() => setMessageLoadAttempt((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      ) : messages === null ? (
        <p className="inbox-detail-loading" aria-live="polite">
          正在加载消息…
        </p>
      ) : (
        <ThreadView messages={messages} />
      )}
    </>
  );
}

export type InboxViewProps = {
  /** 「在聊天中打开」：跳到聊天视图并挂载该会话。 */
  onOpen: (agentId: string, sessionId: string) => void;
  /** 恢复动作：打开会话后就地发起一轮（retry 重发最后一条用户消息，continue 发「请继续」）。 */
  onResume: (agentId: string, sessionId: string, mode: InboxResumeMode) => void;
  /** 行内已读/删除等变更后调用，让 App 刷新侧边栏徽标与会话列表。 */
  onInboxChanged: () => void;
};

export function InboxView({ onOpen, onResume, onInboxChanged }: InboxViewProps) {
  const { workspace, notify } = useWorkspace();
  const agents = workspace.agents;
  const agentName = (agentId: string) =>
    agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const agentMark = (agentId: string) => agents.find((agent) => agent.id === agentId)?.mark ?? '?';

  const [tab, setTab] = useState<InboxTab>('attention');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useAsyncData(() => fetchInbox(tab, appliedQuery || undefined), {
    onError: () => notify('收件箱暂时无法读取'),
  });
  const { reload } = list;
  useEffect(() => {
    void reload();
  }, [reload, tab, appliedQuery]);

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const unreadCount = list.data?.unreadCount ?? 0;
  /** 详情条目始终取列表里的最新数据；条目消失（删除/过滤）时详情自动关闭。 */
  const detail = items.find((item) => item.id === detailId) ?? null;
  const now = new Date();

  /** 乐观更新单条；失败时回源重拉。 */
  const patchItem = (item: InboxItem, patch: Partial<InboxItem>) => {
    list.setData(
      (prev) =>
        prev && {
          ...prev,
          items: prev.items.map((it) => (it.id === item.id ? { ...it, ...patch } : it)),
        },
    );
  };

  const setRead = async (item: InboxItem, read: boolean) => {
    if (item.read === read) return;
    patchItem(item, { read });
    try {
      const updated = await updateInboxState(item.agentId, item.id, { read });
      patchItem(updated, updated);
      onInboxChanged();
    } catch {
      notify('收件箱状态暂时无法保存');
      void reload();
    }
  };

  const removeItems = async (targets: InboxItem[]) => {
    if (!targets.length) return;
    const ids = new Set(targets.map((target) => target.id));
    list.setData(
      (prev) =>
        prev && {
          ...prev,
          items: prev.items.filter((it) => !ids.has(it.id)),
          total: Math.max(0, prev.total - ids.size),
        },
    );
    setSelected((prev) => new Set([...prev].filter((id) => !ids.has(id))));
    try {
      for (const target of targets) await deleteSession(target.agentId, target.id);
    } catch {
      notify('会话暂时无法删除');
    }
    onInboxChanged();
    void reload();
  };

  const handlers: RowHandlers = {
    onRead: (item) => void setRead(item, true),
    onToggleRead: (item) => void setRead(item, !item.read),
    onToggleSelect: (item) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      }),
    onDelete: (item) => void removeItems([item]),
    onOpenDetail: (item) => setDetailId(item.id),
  };

  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const someSelected = items.some((item) => selected.has(item.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = !allSelected && someSelected;
  }, [allSelected, someSelected]);
  const selectedItems = items.filter((item) => selected.has(item.id));

  const emptyCopy = EMPTY_COPY[tab];

  return (
    <div className="inbox">
      <div className="inbox-header">
        <div className="inbox-title-group">
          <EnvelopeSimple size={20} aria-hidden="true" />
          <h3>收件箱</h3>
        </div>
        <div className="inbox-search">
          <MagnifyingGlass size={12} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
        </div>
      </div>

      <div className="session-tabs inbox-tabs" role="tablist" aria-label="收件箱分段">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cx('session-tab', tab === key && 'active')}
            onClick={() => setTab(key)}
          >
            <Icon size={12} aria-hidden="true" />
            {label}
            {key === 'attention' && unreadCount > 0 && (
              <span className="session-tab-count">{unreadCount}</span>
            )}
          </button>
        ))}
      </div>

      <div className={cx('inbox-body', detail && 'split')}>
        <div className="inbox-list-pane">
          <div className="inbox-toolbar">
            <div className="inbox-toolbar-left">
              <input
                ref={selectAllRef}
                type="checkbox"
                className="inbox-checkbox"
                checked={allSelected}
                disabled={!items.length}
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))
                }
                aria-label="全选"
              />
              <button
                type="button"
                className="inbox-refresh"
                onClick={() => void reload()}
                aria-label="刷新收件箱"
                disabled={list.loading}
              >
                <ArrowClockwise size={16} />
              </button>
              {selectedItems.length > 0 && (
                <button
                  type="button"
                  className="header-button"
                  onClick={() => void removeItems(selectedItems)}
                >
                  <Trash size={13} />
                  删除所选（{selectedItems.length}）
                </button>
              )}
            </div>
            <span className="inbox-count">
              {list.loading ? '刷新中…' : `${list.data?.total ?? 0} 个会话`}
            </span>
          </div>

          {!items.length && !list.loading ? (
            <div className="inbox-empty">
              <Tray size={28} aria-hidden="true" />
              {appliedQuery ? (
                <p className="inbox-empty-title">没有匹配「{appliedQuery}」的会话</p>
              ) : (
                <>
                  <p className="inbox-empty-title">{emptyCopy.title}</p>
                  <p className="inbox-empty-hint">{emptyCopy.hint}</p>
                </>
              )}
            </div>
          ) : (
            <div className="inbox-list" role="list">
              <AnimatePresence initial={false}>
                {items.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    agentName={agentName(item.agentId)}
                    agentMark={agentMark(item.agentId)}
                    selected={selected.has(item.id)}
                    now={now}
                    handlers={handlers}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>

        <AnimatePresence>
          {detail && (
            <motion.aside
              key="detail"
              className="inbox-detail"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.15, ease: MOTION_EASE } }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
            >
              <InboxDetail
                item={detail}
                agentName={agentName(detail.agentId)}
                agentMark={agentMark(detail.agentId)}
                onClose={() => setDetailId(null)}
                onOpenChat={() => onOpen(detail.agentId, detail.id)}
                onResume={() =>
                  onResume(
                    detail.agentId,
                    detail.id,
                    detail.attentionReason === 'aborted' ? 'continue' : 'retry',
                  )
                }
              />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
