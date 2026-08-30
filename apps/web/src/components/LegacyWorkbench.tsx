import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { motion } from 'motion/react';
import type {
  AgentDeleteImpact,
  AgentSummary,
  KnowledgeDocument,
  KnowledgeNotebook,
  KnowledgeSearchMode,
  KnowledgeSearchResponse,
  LocalResourcesResponse,
  WakerProject,
  WakerTask,
  WakerWorkflow,
} from '@waker/contracts';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { CheckSquare } from '@phosphor-icons/react/dist/icons/CheckSquare';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { DotsThree } from '@phosphor-icons/react/dist/icons/DotsThree';
import { FlowArrow } from '@phosphor-icons/react/dist/icons/FlowArrow';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { Gauge } from '@phosphor-icons/react/dist/icons/Gauge';
import { Globe } from '@phosphor-icons/react/dist/icons/Globe';
import { Robot } from '@phosphor-icons/react/dist/icons/Robot';
import { BookOpenText } from '@phosphor-icons/react/dist/icons/BookOpenText';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { Plugs } from '@phosphor-icons/react/dist/icons/Plugs';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { MotionLoadingRows } from './MotionFeedback.js';
import type { Notify } from './Toasts.js';
import {
  createKnowledgeNotebook,
  createKnowledgeBinding,
  deleteKnowledgeDocument,
  fetchKnowledgeAudits,
  fetchKnowledgeBindings,
  rebuildKnowledge,
  updateKnowledgeDocument,
  createLocalResource,
  fetchKnowledgeDocuments,
  fetchKnowledgeNotebooks,
  fetchLocalResources,
  searchKnowledge,
  upsertKnowledgeDocument,
  deleteAgent,
  fetchAgentDeleteImpact,
  markAllInboxRead,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';
import {
  MOTION_DIALOG_BACKDROP,
  MOTION_DIALOG_SURFACE,
  MOTION_EASE,
  MOTION_LAYOUT_TRANSITION,
  MOTION_TRANSITION,
} from '../lib/motion.js';
import { AgentChip } from './AgentChip.js';
import { NewAgentDialog } from './NewAgentDialog.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { handleCompositeKeyDown, useDismissable } from '../hooks/useDismissable.js';

export type LegacyView =
  | 'wakers'
  | 'waker-home'
  | 'chat'
  | 'im'
  | 'workflows'
  | 'tasks'
  | 'projects'
  | 'knowledge'
  | 'skills'
  | 'memory'
  | 'capabilities'
  | 'usage'
  | 'settings';

const PRIMARY_NAV: { id: LegacyView; label: string; icon: ReactNode }[] = [
  { id: 'wakers', label: 'Waker 管理', icon: <Robot size={22} /> },
  { id: 'chat', label: 'Chat', icon: <ChatCircle size={22} /> },
  { id: 'im', label: 'IM', icon: <Plugs size={22} /> },
  { id: 'workflows', label: 'WakerFlow', icon: <FlowArrow size={22} /> },
  { id: 'tasks', label: '任务看板', icon: <CheckSquare size={22} /> },
  { id: 'projects', label: '公开项目', icon: <Globe size={22} /> },
  { id: 'knowledge', label: '知识库', icon: <BookOpenText size={22} /> },
];

const UTILITY_NAV: { id: LegacyView; label: string; icon: ReactNode }[] = [
  { id: 'usage', label: '用量', icon: <Gauge size={22} /> },
  { id: 'settings', label: '设置', icon: <GearSix size={22} /> },
];

export function LegacyRail({
  active,
  unreadCount,
  onChange,
}: {
  active: LegacyView;
  unreadCount: number;
  onChange: (view: LegacyView) => void;
}) {
  return (
    <nav className="legacy-rail" aria-label="主导航">
      <button
        type="button"
        className="legacy-logo"
        onClick={() => onChange('wakers')}
        aria-label="Waker 首页"
      >
        <img src="/legacy/qoderwake-icon-cn.svg" alt="" />
      </button>
      <div className="legacy-rail-links">
        {PRIMARY_NAV.map((item) => (
          <button
            type="button"
            key={item.id}
            className={cx('legacy-rail-button', active === item.id && 'active')}
            aria-current={active === item.id ? 'page' : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={() => onChange(item.id)}
          >
            {active === item.id && (
              <motion.i
                className="legacy-rail-active"
                layoutId="legacy-rail-active"
                transition={MOTION_LAYOUT_TRANSITION}
                aria-hidden="true"
              />
            )}
            {item.icon}
            <span className="legacy-rail-label">{item.label}</span>
            {item.id === 'chat' && unreadCount > 0 && (
              <b className="legacy-unread" aria-label={`${unreadCount} 个未读会话`}>
                {unreadCount}
              </b>
            )}
          </button>
        ))}
      </div>
      <div className="legacy-rail-utilities">
        {UTILITY_NAV.map((item) => (
          <button
            type="button"
            key={item.id}
            className={cx('legacy-rail-button', active === item.id && 'active')}
            aria-current={active === item.id ? 'page' : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={() => onChange(item.id)}
          >
            {active === item.id && (
              <motion.i
                className="legacy-rail-active"
                layoutId="legacy-rail-active"
                transition={MOTION_LAYOUT_TRANSITION}
                aria-hidden="true"
              />
            )}
            {item.icon}
            <span className="legacy-rail-label">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

type WakersTab = 'wakers' | 'groups';
const WAKERS_TABS: WakersTab[] = ['wakers', 'groups'];
/** 'all' 或本机 hostname；本地模式只有一台机器，选择本机环境与全部环境结果相同但都是真实过滤。 */
type WakerEnvironment = 'all' | (string & {});

const WAKER_PAGE_SIZE = 12;

export function WakersView({
  agents,
  hostName,
  onChat,
  onConfigure,
  onMemory,
  onCapabilities,
  onAutomation,
  onOpenHome,
  onCreated,
  onDeleted,
  onReadAll,
  notify,
  onboarding,
}: {
  agents: AgentSummary[];
  /** 本机 hostname，来自 GET /api/v1/workspace 的 host.name。 */
  hostName: string;
  onChat: (id: string) => void;
  onConfigure: (id: string) => void;
  onMemory: (id: string) => void;
  onCapabilities: (id: string) => void;
  onAutomation: (id: string) => void;
  /** 卡片上半区的角色详情入口：打开该 Waker 的 Home 视图。 */
  onOpenHome: (id: string) => void;
  onCreated: (id: string) => void;
  onDeleted: (id: string) => void;
  /** 全部标为已读成功后由 App 刷新 workspace + inbox。 */
  onReadAll: () => void;
  notify: Notify;
  onboarding?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<WakersTab>('wakers');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [environment, setEnvironment] = useState<WakerEnvironment>('all');
  const [envMenuOpen, setEnvMenuOpen] = useState(false);
  const [menuAgentId, setMenuAgentId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteImpact, setDeleteImpact] = useState<AgentDeleteImpact | null>(null);
  const [deleteImpactError, setDeleteImpactError] = useState('');
  const deleteImpactGenerationRef = useRef(0);
  const deleteTargetIdRef = useRef<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteWasOpen = useRef(false);
  const envMenuRef = useRef<HTMLDivElement>(null);
  const envTriggerRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const closeEnvMenu = useCallback(() => setEnvMenuOpen(false), []);
  const closeMoreMenu = useCallback(() => setMenuAgentId(null), []);
  const navigateTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const current = WAKERS_TABS.indexOf(tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? WAKERS_TABS.length - 1
          : (current + (event.key === 'ArrowLeft' ? -1 : 1) + WAKERS_TABS.length) %
            WAKERS_TABS.length;
    event.preventDefault();
    setTab(WAKERS_TABS[next]!);
    buttons[next]?.focus();
  };
  useDismissable(envMenuRef, closeEnvMenu, envMenuOpen);
  useDismissable(moreMenuRef, closeMoreMenu, menuAgentId !== null);
  const closeDeleteDialog = useCallback(() => {
    deleteImpactGenerationRef.current += 1;
    deleteTargetIdRef.current = null;
    setDeleteTarget(null);
    setDeleteConfirmation('');
    setDeleteImpact(null);
    setDeleteImpactError('');
  }, []);
  const deleteDialogRef = useDialogFocus<HTMLFormElement>(Boolean(deleteTarget), closeDeleteDialog);
  useEffect(() => {
    if (deleteTarget) deleteWasOpen.current = true;
    else if (deleteWasOpen.current) {
      deleteWasOpen.current = false;
      deleteTriggerRef.current?.focus();
    }
  }, [deleteTarget]);
  const loadDeleteImpact = useCallback(async (agent: AgentSummary) => {
    const generation = ++deleteImpactGenerationRef.current;
    deleteTargetIdRef.current = agent.id;
    setDeleteImpact(null);
    setDeleteImpactError('');
    try {
      const impact = await fetchAgentDeleteImpact(agent.id);
      if (
        generation !== deleteImpactGenerationRef.current ||
        deleteTargetIdRef.current !== agent.id
      )
        return;
      setDeleteImpact(impact);
    } catch (cause) {
      if (
        generation !== deleteImpactGenerationRef.current ||
        deleteTargetIdRef.current !== agent.id
      )
        return;
      setDeleteImpactError(cause instanceof Error ? cause.message : 'Waker 删除影响暂时无法读取');
    }
  }, []);
  // 本地语义：每个 Waker 都由本机 Codex runtime 承载，因此全部在线且同属于本机环境；
  // 「仅在线」与环境过滤是真实条件过滤，只是本地数据集里这两个集合恒等于全集。
  const isOnline = useCallback((_agent: AgentSummary) => true, []);
  const environmentOf = useCallback((_agent: AgentSummary) => hostName, [hostName]);
  const visibleAgents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    let list = agents;
    if (onlineOnly) list = list.filter((agent) => isOnline(agent));
    if (environment !== 'all') list = list.filter((agent) => environmentOf(agent) === environment);
    if (normalized)
      list = list.filter((agent) =>
        [agent.name, agent.tagline, agent.description].some((value) =>
          value.toLocaleLowerCase().includes(normalized),
        ),
      );
    return list;
  }, [agents, query, onlineOnly, environment, isOnline, environmentOf]);
  const totalUnread = useMemo(
    () => agents.reduce((sum, agent) => sum + (agent.unreadCount ?? 0), 0),
    [agents],
  );
  const pageCount = Math.max(1, Math.ceil(visibleAgents.length / WAKER_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedAgents = visibleAgents.slice(
    (currentPage - 1) * WAKER_PAGE_SIZE,
    currentPage * WAKER_PAGE_SIZE,
  );
  useEffect(() => {
    setPage(1);
  }, [query, onlineOnly, environment, tab]);
  const markAllRead = useCallback(async () => {
    setMarkingAll(true);
    try {
      await markAllInboxRead();
      onReadAll();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '全部标为已读失败', 'error');
    } finally {
      setMarkingAll(false);
    }
  }, [notify, onReadAll]);
  return (
    <section className="legacy-page" aria-labelledby="wakers-title">
      <PageHeader
        id="wakers-title"
        title="我的Wakers"
        detail="跨云端、本地与其他设备管理你的 Waker，快速发起对话任务和自动任务。"
      >
        {tab === 'wakers' && (
          <button
            type="button"
            className="legacy-button primary"
            onClick={() => setCreating(true)}
          >
            <Plus size={16} /> 新建Waker
          </button>
        )}
      </PageHeader>
      {onboarding}
      <div
        className="waker-tabs"
        role="tablist"
        aria-label="管理分类"
        onKeyDown={navigateTabs}
      >
        <button
          type="button"
          role="tab"
          id="wakers-tab-wakers"
          aria-selected={tab === 'wakers'}
          aria-controls="wakers-panel"
          tabIndex={tab === 'wakers' ? 0 : -1}
          className={cx('waker-tab', tab === 'wakers' && 'active')}
          onClick={() => setTab('wakers')}
        >
          我的Waker
        </button>
        <button
          type="button"
          role="tab"
          id="wakers-tab-groups"
          aria-selected={tab === 'groups'}
          aria-controls="wakers-panel"
          tabIndex={tab === 'groups' ? 0 : -1}
          className={cx('waker-tab', tab === 'groups' && 'active')}
          onClick={() => setTab('groups')}
        >
          我的群组
        </button>
      </div>
      {tab === 'groups' ? (
        <div
          className="waker-groups-notice"
          role="tabpanel"
          id="wakers-panel"
          aria-labelledby="wakers-tab-groups"
        >
          <h2>云端多 Waker 群组在本地模式不可用</h2>
          <p>
            「我的群组」是 QoderWake 云端的多 Waker
            群聊，依赖云端账号与同步服务；本地工作区不连接云端，因此这里没有群组数据，也不提供「新建群组」。
          </p>
          <p>
            本地聊天以单个 Waker 为单位：在「我的Waker」中选择一个 Waker 创建对话任务或自动任务。
          </p>
        </div>
      ) : (
        <div role="tabpanel" id="wakers-panel" aria-labelledby="wakers-tab-wakers">
          {agents.length > 0 && (
            <div className="waker-toolbar">
              <button
                type="button"
                className={cx('waker-toggle', onlineOnly && 'active')}
                aria-pressed={onlineOnly}
                onClick={() => setOnlineOnly((value) => !value)}
              >
                <i aria-hidden="true" />
                仅在线
              </button>
              <div
                className="waker-env"
                ref={envMenuRef}
                onBlur={(event) => {
                  if (envMenuOpen && !event.currentTarget.contains(event.relatedTarget))
                    setEnvMenuOpen(false);
                }}
              >
                <button
                  ref={envTriggerRef}
                  type="button"
                  className="waker-env-button"
                  aria-haspopup="menu"
                  aria-expanded={envMenuOpen}
                  onClick={() => setEnvMenuOpen((open) => !open)}
                >
                  环境 / {environment === 'all' ? '全部环境' : environment}
                  <CaretDown size={12} aria-hidden="true" />
                </button>
                <>
                  {envMenuOpen && (
                    <motion.div
                      className="waker-env-menu"
                      role="menu"
                      aria-label="环境"
                      initial={{ opacity: 0, scale: 0.98, y: -3 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ duration: 0.12, ease: MOTION_EASE }}
                      style={{ transformOrigin: 'top left' }}
                      onKeyDown={(event) =>
                        handleCompositeKeyDown(event, () => {
                          setEnvMenuOpen(false);
                          envTriggerRef.current?.focus();
                        })
                      }
                    >
                      <button
                        autoFocus
                        type="button"
                        role="menuitemradio"
                        tabIndex={-1}
                        aria-checked={environment === hostName}
                        onClick={() => {
                          setEnvironment(hostName);
                          setEnvMenuOpen(false);
                          envTriggerRef.current?.focus();
                        }}
                      >
                        <span className="waker-env-name">
                          {hostName}
                          <small>当前机器</small>
                        </span>
                        <span className="waker-env-meta">
                          在线 {agents.length} 名<small>本地</small>
                        </span>
                      </button>
                      <button
                        type="button"
                        role="menuitemradio"
                        tabIndex={-1}
                        aria-checked={environment === 'all'}
                        onClick={() => {
                          setEnvironment('all');
                          setEnvMenuOpen(false);
                          envTriggerRef.current?.focus();
                        }}
                      >
                        <span className="waker-env-name">全部环境</span>
                        <span className="waker-env-meta">{agents.length} 名员工</span>
                      </button>
                    </motion.div>
                  )}
                </>
              </div>
              <div className="waker-toolbar-search">
                <MagnifyingGlass size={16} aria-hidden="true" />
                <input
                  aria-label="搜索 Waker"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索员工或者设备..."
                />
                <span>
                  {visibleAgents.length}/{agents.length}
                </span>
              </div>
              {totalUnread > 0 && (
                <button
                  type="button"
                  className="legacy-button"
                  disabled={markingAll}
                  onClick={() => void markAllRead()}
                >
                  {markingAll ? '正在标记…' : '全部标为已读'}
                </button>
              )}
            </div>
          )}
          {visibleAgents.length ? (
            <motion.div className="waker-grid" layout>
              {pagedAgents.map((agent) => (
                <motion.article
                  className="waker-card"
                  key={agent.id}
                  layout="position"
                  initial={{ opacity: 0, scale: 0.985 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={MOTION_TRANSITION.routine}
                >
                  <button
                    type="button"
                    className="waker-card-open"
                    aria-label={`查看 ${agent.name} 的角色详情`}
                    onClick={() => onOpenHome(agent.id)}
                  >
                    <div className="waker-card-identity">
                      <AgentChip
                        mark={agent.mark}
                        className="qoderwake-avatar"
                        agentId={agent.id}
                        hasAvatar={agent.hasAvatar}
                      />
                      <div className="waker-card-copy">
                        <h2>
                          {agent.name}
                          {agent.tagline && <span className="waker-card-role">{agent.tagline}</span>}
                        </h2>
                        <div className="waker-card-presence">
                          <span className="waker-card-device">本机</span>
                          <span className="status-dot">在线</span>
                          {(agent.unreadCount ?? 0) > 0 && (
                            <b className="waker-unread" aria-label={`${agent.unreadCount} 个未读会话`}>
                              {agent.unreadCount}
                            </b>
                          )}
                        </div>
                        <p>{agent.description || agent.tagline || '本地 Waker'}</p>
                      </div>
                    </div>
                  </button>
                  <div className="waker-actions">
                    <button
                      type="button"
                      className="legacy-button primary"
                      onClick={() => onChat(agent.id)}
                    >
                      <ChatCircle size={15} /> 创建对话任务
                    </button>
                    <button
                      type="button"
                      className="legacy-button"
                      onClick={() => onAutomation(agent.id)}
                    >
                      <FlowArrow size={15} /> 创建自动任务
                    </button>
                    <div
                      className="waker-more"
                      ref={menuAgentId === agent.id ? moreMenuRef : undefined}
                      onBlur={(event) => {
                        if (
                          menuAgentId === agent.id &&
                          !event.currentTarget.contains(event.relatedTarget)
                        )
                          setMenuAgentId(null);
                      }}
                    >
                      <button
                        type="button"
                        className="legacy-button"
                        ref={menuAgentId === agent.id ? moreTriggerRef : undefined}
                        aria-haspopup="menu"
                        aria-expanded={menuAgentId === agent.id}
                        aria-label={`${agent.name} 的更多操作`}
                        onClick={() =>
                          setMenuAgentId((current) => (current === agent.id ? null : agent.id))
                        }
                      >
                        <DotsThree size={16} aria-hidden="true" />
                      </button>
                      <>
                        {menuAgentId === agent.id && (
                          <motion.div
                            className="waker-more-menu"
                            role="menu"
                            aria-label={`${agent.name} 的更多操作`}
                            initial={{ opacity: 0, scale: 0.98, y: -3 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            transition={{ duration: 0.12, ease: MOTION_EASE }}
                            style={{ transformOrigin: 'top right' }}
                            onKeyDown={(event) =>
                              handleCompositeKeyDown(event, () => {
                                setMenuAgentId(null);
                                moreTriggerRef.current?.focus();
                              })
                            }
                          >
                            <button
                              autoFocus
                              type="button"
                              role="menuitem"
                              tabIndex={-1}
                              onClick={() => {
                                setMenuAgentId(null);
                                moreTriggerRef.current?.focus();
                                onConfigure(agent.id);
                              }}
                            >
                              配置
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              tabIndex={-1}
                              onClick={() => {
                                setMenuAgentId(null);
                                moreTriggerRef.current?.focus();
                                onMemory(agent.id);
                              }}
                            >
                              记忆
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              tabIndex={-1}
                              onClick={() => {
                                setMenuAgentId(null);
                                moreTriggerRef.current?.focus();
                                onCapabilities(agent.id);
                              }}
                            >
                              能力
                            </button>
                            <a
                              role="menuitem"
                              tabIndex={-1}
                              href={`/api/v1/agents/${encodeURIComponent(agent.id)}/source`}
                              download={`${agent.id}.md`}
                              onClick={() => {
                                setMenuAgentId(null);
                                moreTriggerRef.current?.focus();
                              }}
                            >
                              导出
                            </a>
                            <a
                              role="menuitem"
                              tabIndex={-1}
                              href={`/api/v1/agents/${encodeURIComponent(agent.id)}/export-package`}
                              download={`${agent.id}.wakerpack`}
                              onClick={() => {
                                setMenuAgentId(null);
                                moreTriggerRef.current?.focus();
                              }}
                            >
                              导出整包
                            </a>
                            <button
                              type="button"
                              role="menuitem"
                              tabIndex={-1}
                              className="danger"
                              onClick={() => {
                                // 菜单项随菜单关闭卸载，焦点恢复落到「更多操作」触发按钮上。
                                deleteTriggerRef.current = moreTriggerRef.current;
                                setMenuAgentId(null);
                                setDeleteTarget(agent);
                                void loadDeleteImpact(agent);
                              }}
                            >
                              删除
                            </button>
                          </motion.div>
                        )}
                      </>
                    </div>
                  </div>
                </motion.article>
              ))}
            </motion.div>
          ) : agents.length ? (
            <EmptyState title="没有匹配的 Waker。" detail="调整搜索词，或清空搜索查看全部 Waker。" />
          ) : (
            <EmptyState
              image="/legacy/waker-builtin-icon.svg"
              title="暂无 Waker"
              detail="创建一个 Waker，让它承接任务、自动化和项目上下文。"
            />
          )}
          {pageCount > 1 && (
            <nav className="waker-pagination" aria-label="Waker 分页">
              <button
                type="button"
                className="legacy-button"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <span>
                {currentPage} / {pageCount}
              </span>
              <button
                type="button"
                className="legacy-button"
                disabled={currentPage >= pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </div>
      )}
      <NewAgentDialog
        open={creating}
        onClose={() => setCreating(false)}
        hostName={hostName}
        onAvatarError={notify}
        onCreated={(id) => {
          setCreating(false);
          onCreated(id);
        }}
      />
      {deleteTarget && (
        <motion.div
          className="modal-backdrop"
          {...MOTION_DIALOG_BACKDROP}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDeleteDialog();
            }
          }}
        >
          <motion.form
            ref={deleteDialogRef}
            tabIndex={-1}
            className="memory-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-waker-title"
            {...MOTION_DIALOG_SURFACE}
            onSubmit={async (event) => {
              event.preventDefault();
              if (deleteConfirmation !== deleteTarget.name) return;
              try {
                await deleteAgent(deleteTarget.id);
                onDeleted(deleteTarget.id);
                setDeleteTarget(null);
                setDeleteConfirmation('');
              } catch (cause) {
                notify(cause instanceof Error ? cause.message : '删除失败', 'error');
              }
            }}
          >
            <h2 id="delete-waker-title">删除 {deleteTarget.name}</h2>
            {deleteImpact ? (
              <div className="modal-hint">
                <p>
                  将删除定义、{deleteImpact.sessions} 个会话、{deleteImpact.projects} 个项目和{' '}
                  {deleteImpact.connectors} 个连接器。
                </p>
                <p>
                  {deleteImpact.automations} 个 Automation、{deleteImpact.workflows} 个 Workflow、
                  {deleteImpact.tasks} 条 Task 与 {deleteImpact.humanActions} 条 Human Action
                  将保留审计数据但不再对同 ID Waker 可见。
                </p>
                <p>
                  {deleteImpact.memories} 条 Memory 将软删除，{deleteImpact.knowledgeBindings}{' '}
                  个 Knowledge binding 将解除。
                </p>
                <p>{deleteImpact.sharedSkills} 个工作区共享 Skill 不受影响。</p>
              </div>
            ) : deleteImpactError ? (
              <div className="legacy-error" role="alert">
                <p>{deleteImpactError}</p>
                <button
                  className="legacy-button"
                  type="button"
                  onClick={() => void loadDeleteImpact(deleteTarget)}
                >
                  重新检查
                </button>
              </div>
            ) : (
              <p role="status">正在检查 Waker 删除影响…</p>
            )}
            <p>请输入 Waker 名称确认。</p>
            <label>
              Waker 名称
              <input
                autoFocus
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="legacy-button"
                onClick={() => {
                  closeDeleteDialog();
                }}
              >
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={!deleteImpact || deleteConfirmation !== deleteTarget.name}
              >
                确认删除
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </section>
  );
}

export function ResourcesView({
  kind,
  wakerId,
  notify,
}: {
  kind: 'projects' | 'workflows' | 'tasks' | 'im';
  wakerId?: string;
  notify: Notify;
}) {
  const [data, setData] = useState<LocalResourcesResponse | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const load = useCallback(() => {
    setError('');
    if (!wakerId) {
      setData({ projects: [], automations: [], workflows: [], channels: [], tasks: [] });
      return;
    }
    fetchLocalResources(wakerId)
      .then(setData)
      .catch((cause) => setError(cause instanceof Error ? cause.message : '资源加载失败'));
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const reload = () => load();
    window.addEventListener('waker:resources-changed', reload);
    return () => window.removeEventListener('waker:resources-changed', reload);
  }, [load]);
  const title =
    kind === 'projects'
      ? '公开项目'
      : kind === 'workflows'
        ? 'WakerFlow'
        : kind === 'tasks'
          ? '任务看板'
          : 'IM';
  const items =
    kind === 'projects'
      ? data?.projects.filter((item) => item.visibility === 'public')
      : kind === 'workflows'
        ? data?.workflows
        : kind === 'tasks'
          ? data?.tasks
          : data?.channels;
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value || kind === 'im') return;
    setSubmitting(true);
    try {
      if (!wakerId) throw new Error('请先创建或选择一个 Waker');
      if (kind === 'projects')
        await createLocalResource<WakerProject>('projects', {
          wakerId,
          name: value,
          description: '本地公开项目',
          visibility: 'public',
          source: 'filesystem',
          path: '.',
        });
      if (kind === 'workflows')
        await createLocalResource<WakerWorkflow>('workflows', {
          name: value,
          description: '本地流程',
          script: '',
          status: 'draft',
        });
      if (kind === 'tasks')
        await createLocalResource<WakerTask>('tasks', {
          wakerId,
          title: value,
          type: 'workflow',
          source: 'local',
        });
      setName('');
      load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '创建失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="legacy-page">
      <PageHeader
        title={title}
        detail={
          kind === 'im'
            ? '连接外部消息渠道，或使用内置本地通道。'
            : '数据来自本地 SQLite，可离线管理。'
        }
      />
      {kind === 'im' && (
        <div className="local-notice">
          <Plugs size={18} />
          <div>
            <strong>本地演示</strong>
            <p>第三方连接器未配置。钉钉、飞书、微信、企业微信与 QQ 不会伪造连接状态。</p>
          </div>
        </div>
      )}
      {kind !== 'im' && (
        <form className="inline-create" onSubmit={create}>
          <label>
            <span>{kind === 'tasks' ? '任务标题' : '名称'}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`新建${title}`}
            />
          </label>
          <button className="legacy-button primary" disabled={!name.trim() || submitting}>
            {submitting ? '创建中…' : '创建'}
          </button>
        </form>
      )}
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !data ? (
        <LoadingRows />
      ) : items?.length ? (
        <div className="resource-table" role="table" aria-label={title}>
          {items.map((item) => (
            <div className="resource-row" role="row" key={item.id}>
              <div>
                <strong>{'title' in item ? item.title : item.name}</strong>
                <small>
                  {'provider' in item
                    ? item.provider
                    : 'description' in item
                      ? item.description || item.id
                      : item.id}
                </small>
              </div>
              <span className={cx('resource-status', item.status)}>{item.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          image="/legacy/empty-project-icon.svg"
          title={`还没有${title}`}
          detail={kind === 'im' ? '连接器配置后会显示在这里。' : '使用上方表单创建第一条本地记录。'}
        />
      )}
    </section>
  );
}

export function KnowledgeView({
  wakerId,
  notify,
}: {
  wakerId?: string;
  notify: Notify;
}) {
  const [notebooks, setNotebooks] = useState<KnowledgeNotebook[] | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<KnowledgeSearchMode>('hybrid');
  const [results, setResults] = useState<KnowledgeSearchResponse | null>(null);
  const [error, setError] = useState('');
  const [notebookTitle, setNotebookTitle] = useState('');
  const [docEditor, setDocEditor] = useState<{
    id?: string;
    version?: number;
    title: string;
    content: string;
    sourceType: KnowledgeDocument['sourceType'];
    uri: string;
  } | null>(null);
  const documentTriggerRef = useRef<HTMLButtonElement>(null);
  const documentWasOpen = useRef(false);
  const [knowledgeMeta, setKnowledgeMeta] = useState<{
    bindings: Awaited<ReturnType<typeof fetchKnowledgeBindings>>;
    audits: Array<Record<string, unknown>>;
  }>({ bindings: [], audits: [] });
  const closeDocumentDialog = useCallback(() => {
    setDocEditor(null);
  }, []);
  const documentDialogRef = useDialogFocus<HTMLFormElement>(
    Boolean(docEditor),
    closeDocumentDialog,
  );
  useEffect(() => {
    if (docEditor) documentWasOpen.current = true;
    else if (documentWasOpen.current) {
      documentWasOpen.current = false;
      documentTriggerRef.current?.focus();
    }
  }, [docEditor]);
  const load = useCallback(async () => {
    try {
      if (!wakerId) {
        setNotebooks([]);
        return;
      }
      const books = await fetchKnowledgeNotebooks({ kind: 'waker', id: wakerId });
      setNotebooks(books);
      setSelected((current) => current || books[0]?.id || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '知识库加载失败');
    }
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (selected && wakerId)
      void Promise.all([
        fetchKnowledgeDocuments(selected, { kind: 'waker', id: wakerId }),
        fetchKnowledgeBindings(),
        fetchKnowledgeAudits(selected),
      ])
        .then(([docs, bindings, audits]) => {
          setDocuments(docs);
          setKnowledgeMeta({
            bindings: bindings.filter((item) => item.notebookId === selected),
            audits,
          });
        })
        .catch(() => {
          setDocuments([]);
          setKnowledgeMeta({ bindings: [], audits: [] });
        });
  }, [selected, wakerId]);
  const createNotebook = async (event: FormEvent) => {
    event.preventDefault();
    const title = notebookTitle.trim();
    if (!title) return;
    if (!wakerId) {
      notify('请先创建或选择一个 Waker', 'info');
      return;
    }
    try {
      const notebook = await createKnowledgeNotebook({ title });
      await createKnowledgeBinding({
        notebookId: notebook.id,
        scope: { kind: 'waker', id: wakerId },
        access: 'read_write',
      });
      setNotebookTitle('');
      await load();
      setSelected(notebook.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '创建失败', 'error');
    }
  };
  const createDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !wakerId || !docEditor) return;
    try {
      const scope = { kind: 'waker' as const, id: wakerId };
      if (docEditor.id && docEditor.version)
        await updateKnowledgeDocument(docEditor.id, {
          expectedVersion: docEditor.version,
          title: docEditor.title.trim(),
          content: docEditor.content.trim(),
          scope,
        });
      else
        await upsertKnowledgeDocument({
          notebookId: selected,
          title: docEditor.title.trim(),
          content: docEditor.content.trim(),
          sourceType: docEditor.sourceType,
          ...(docEditor.uri ? { uri: docEditor.uri } : {}),
          scope,
        });
      closeDocumentDialog();
      setDocuments(await fetchKnowledgeDocuments(selected, scope));
      await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '文档保存失败', 'error');
    }
  };
  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    if (!wakerId) {
      notify('请先创建或选择一个 Waker', 'info');
      return;
    }
    try {
      setResults(
        await searchKnowledge({
          scope: { kind: 'waker', id: wakerId },
          notebookId: selected || undefined,
          query: query.trim(),
          mode,
          limit: 12,
        }),
      );
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '检索失败', 'error');
    }
  };
  const selectedBook = useMemo(
    () => notebooks?.find((item) => item.id === selected),
    [notebooks, selected],
  );
  const canWrite = !knowledgeMeta.bindings.some(
    (binding) => binding.notebookId === selected && binding.access === 'read_only',
  );
  return (
    <section className="legacy-page">
      <PageHeader title="知识库" detail="关键词与向量混合检索，结果可追溯到本地文档。">
        <button
          type="button"
          className="legacy-button"
          onClick={() => setNotebookTitle('新知识库')}
        >
          <Plus size={15} />
          新建知识库
        </button>
        <button
          type="button"
          className="legacy-button primary"
          disabled={!selected || !canWrite}
          title={!canWrite ? '只读绑定不能修改文档' : undefined}
          onClick={(event) => {
            event.currentTarget.focus();
            documentTriggerRef.current = event.currentTarget;
            setDocEditor({ title: '', content: '', sourceType: 'text', uri: '' });
          }}
        >
          <Plus size={15} />
          新建文档
        </button>
        <button
          type="button"
          className="legacy-button"
          disabled={!selected}
          onClick={async () =>
            notify(
              '已重建 ' +
                (await rebuildKnowledge({ notebookId: selected, force: true })) +
                ' 个分块',
              'success',
            )
          }
        >
          重建索引 · {knowledgeMeta.bindings.length} 绑定 / {knowledgeMeta.audits.length} 审计
        </button>
      </PageHeader>
      <form className="inline-create" onSubmit={createNotebook}>
        <label>
          <span>知识库名称</span>
          <input
            aria-label="知识库名称"
            value={notebookTitle}
            onChange={(event) => setNotebookTitle(event.target.value)}
            placeholder="新知识库"
          />
        </label>
        <button className="legacy-button" disabled={!notebookTitle.trim()}>
          创建知识库
        </button>
      </form>
      {docEditor && (
        <motion.div
          className="modal-backdrop"
          {...MOTION_DIALOG_BACKDROP}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDocumentDialog();
          }}
        >
          <motion.form
            ref={documentDialogRef}
            tabIndex={-1}
            className="memory-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="新建知识文档"
            onSubmit={createDocument}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2>新建知识文档</h2>
            <label>
              标题
              <input
                autoFocus
                value={docEditor.title}
                onChange={(event) => setDocEditor({ ...docEditor, title: event.target.value })}
              />
            </label>
            <label>
              类型
              <select
                value={docEditor.sourceType}
                onChange={(event) =>
                  setDocEditor({
                    ...docEditor,
                    sourceType: event.target.value as KnowledgeDocument['sourceType'],
                  })
                }
              >
                <option value="text">Text</option>
                <option value="markdown">Markdown</option>
                <option value="web">Web</option>
              </select>
            </label>
            <label>
              来源 URI
              <input
                value={docEditor.uri}
                onChange={(event) => setDocEditor({ ...docEditor, uri: event.target.value })}
              />
            </label>
            <label>
              内容
              <textarea
                rows={10}
                value={docEditor.content}
                onChange={(event) => setDocEditor({ ...docEditor, content: event.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" className="legacy-button" onClick={closeDocumentDialog}>
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={!docEditor.title.trim() || !docEditor.content.trim()}
              >
                保存
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !notebooks ? (
        <LoadingRows />
      ) : (
        <div className="knowledge-layout">
          <aside className="notebook-list">
            <h2>知识库</h2>
            {notebooks.map((book) => (
              <button
                key={book.id}
                type="button"
                className={cx(selected === book.id && 'active')}
                onClick={() => setSelected(book.id)}
              >
                <BookOpenText size={17} />
                <span>
                  {book.title}
                  <small>{book.documentCount} 篇文档</small>
                </span>
              </button>
            ))}
          </aside>
          <div className="knowledge-main">
            <form className="knowledge-search" onSubmit={search}>
              <MagnifyingGlass size={18} />
              <input
                aria-label="搜索知识库"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索本地知识…"
              />
              <select
                aria-label="检索方式"
                value={mode}
                onChange={(event) => setMode(event.target.value as KnowledgeSearchMode)}
              >
                <option value="hybrid">混合检索</option>
                <option value="keyword">关键词</option>
                <option value="vector">向量</option>
              </select>
              <button className="legacy-button primary" disabled={!query.trim()}>
                搜索
              </button>
            </form>
            {results ? (
              <div className="search-results">
                <div className="results-meta">
                  {results.total} 条结果 · {results.modeUsed}
                  {results.degraded ? ' · 已降级' : ''}
                </div>
                {results.results.map((result) => (
                  <article key={result.chunkId}>
                    <h3>{result.title}</h3>
                    <p>{result.snippet || result.content}</p>
                    <code>{result.citation}</code>
                    <span>相关度 {result.score.toFixed(3)}</span>
                  </article>
                ))}
              </div>
            ) : (
              <>
                <div className="section-heading">
                  <div>
                    <h2>{selectedBook?.title ?? '选择知识库'}</h2>
                    <p>{selectedBook?.description || '本地文档与版本记录'}</p>
                  </div>
                </div>
                {documents.length ? (
                  <div className="document-list">
                    {documents.map((doc) => (
                      <div key={doc.id}>
                        <BookOpenText size={18} />
                        <span>
                          <strong>{doc.title}</strong>
                          <small>
                            版本 {doc.version} · {doc.sourceType}
                          </small>
                        </span>
                        <button
                          className="legacy-text-button"
                          disabled={!canWrite}
                          title={!canWrite ? '只读绑定' : undefined}
                          onClick={(event) => {
                            event.currentTarget.focus();
                            documentTriggerRef.current = event.currentTarget;
                            setDocEditor({
                              id: doc.id,
                              version: doc.version,
                              title: doc.title,
                              content: doc.content,
                              sourceType: doc.sourceType,
                              uri: doc.uri ?? '',
                            });
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="legacy-text-button"
                          disabled={!canWrite}
                          title={!canWrite ? '只读绑定' : undefined}
                          onClick={async () => {
                            if (!wakerId) return;
                            await deleteKnowledgeDocument(doc.id, { kind: 'waker', id: wakerId });
                            setDocuments(
                              await fetchKnowledgeDocuments(selected, {
                                kind: 'waker',
                                id: wakerId,
                              }),
                            );
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="还没有文档"
                    detail="创建一篇文本或 Markdown 文档，随后即可检索。"
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PageHeader({
  id,
  title,
  detail,
  children,
}: {
  id?: string;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <header className="legacy-page-header">
      <div>
        <h1 id={id}>{title}</h1>
        <p>{detail}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
function EmptyState({ image, title, detail }: { image?: string; title: string; detail: string }) {
  return (
    <div className="legacy-empty">
      {image && <img src={image} alt="" />}
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="legacy-error" role="alert">
      <strong>加载失败</strong>
      <p>{message}</p>
      <button type="button" className="legacy-button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
function LoadingRows() {
  return <MotionLoadingRows />;
}
