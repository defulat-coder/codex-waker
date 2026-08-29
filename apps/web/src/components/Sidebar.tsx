import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { ChartLine } from '@phosphor-icons/react/dist/icons/ChartLine';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { DotsThree } from '@phosphor-icons/react/dist/icons/DotsThree';
import { FileArrowUp } from '@phosphor-icons/react/dist/icons/FileArrowUp';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { Keyboard } from '@phosphor-icons/react/dist/icons/Keyboard';
import { Layout } from '@phosphor-icons/react/dist/icons/Layout';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { SidebarSimple } from '@phosphor-icons/react/dist/icons/SidebarSimple';
import { Tray } from '@phosphor-icons/react/dist/icons/Tray';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { Users } from '@phosphor-icons/react/dist/icons/Users';
import { X } from '@phosphor-icons/react/dist/icons/X';
import type { ExploreView } from '../lib/explore.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import type { SystemView } from '../lib/types.js';
import { deleteAgent, importAgentDefinition } from '../lib/api.js';
import { useDismissable } from '../hooks/useDismissable.js';
import { useWorkspace } from '../context/WorkspaceContext.js';
import { AgentChip } from './AgentChip.js';
import { NewAgentDialog } from './NewAgentDialog.js';

export type SidebarProps = {
  currentAgentId: string | undefined;
  collapsed: boolean;
  inboxOpen: boolean;
  inboxCount: number;
  /** 每个 Agent 需要处理的会话数（用于行尾徽标）。 */
  attentionByAgent: Record<string, number>;
  exploreView: ExploreView | null;
  systemView: SystemView | null;
  /** 账户区第二行的真实信息，如 "codex-samples · .codex/sessions"。 */
  workspaceInfo?: string;
  onToggleCollapsed: () => void;
  onSelectAgent: (agentId: string) => void;
  onOpenConfig: (agentId: string) => void;
  /** Fleet "From template"：打开模板页。 */
  onOpenTemplates: () => void;
  onAgentCreated: (agentId: string) => void;
  onAgentDeleted: (agentId: string) => void;
  /** Fleet 的 Search（⌘K）：打开命令面板。 */
  onOpenPalette: () => void;
  /** Fleet 的 Keyboard Shortcuts 导航项。 */
  onOpenShortcuts: () => void;
  onOpenInbox: () => void;
  onCloseInbox: () => void;
  onOpenExplore: (view: ExploreView) => void;
  onOpenSystem: (view: SystemView) => void;
};

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <span className="nav-icon" aria-hidden="true">
      {children}
    </span>
  );
}

/** Fleet 侧边栏：纯导航（工作区 / 搜索 / Chat / Inbox / Explore / My Agents / Usage / Settings / 账户）。 */
export function Sidebar(props: SidebarProps) {
  const { workspace, notify } = useWorkspace();
  const agents = workspace.agents;
  const {
    currentAgentId,
    collapsed,
    inboxOpen,
    inboxCount,
    attentionByAgent,
    exploreView,
    systemView,
    workspaceInfo,
  } = props;
  const [exploreOpen, setExploreOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createMenuPosition, setCreateMenuPosition] = useState({ top: 0, left: 0 });
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [agentMenuId, setAgentMenuId] = useState<string | null>(null);
  const [agentMenuPosition, setAgentMenuPosition] = useState({ top: 0, left: 0 });
  const [deleteAgentId, setDeleteAgentId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const chatActive = !inboxOpen && !exploreView && !systemView;

  // ⌘B 收起/展开侧边栏；⌘K 打开命令面板（Fleet 同名快捷键）
  const { onToggleCollapsed, onOpenPalette } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'b') {
        event.preventDefault();
        onToggleCollapsed();
      } else if (event.key === 'k') {
        event.preventDefault();
        onOpenPalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggleCollapsed, onOpenPalette]);

  // 工作区信息弹层：点外部或 Escape 关闭
  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);
  const closeCreateMenu = useCallback(() => setCreateMenuOpen(false), []);
  const closeAgentMenu = useCallback(() => setAgentMenuId(null), []);
  useDismissable(workspaceRef, closeWorkspace, workspaceOpen);
  useDismissable(createMenuRef, closeCreateMenu, createMenuOpen);
  useDismissable(agentMenuRef, closeAgentMenu, agentMenuId !== null);

  const importDefinition = async (file: File) => {
    const id = file.name.replace(/\.md$/i, '');
    if (!file.name.toLowerCase().endsWith('.md')) {
      notify('请选择 Markdown（.md）Agent 定义文件');
      return;
    }
    setImporting(true);
    try {
      const created = await importAgentDefinition({ id, content: await file.text() });
      notify(`已导入 ${created.name}`);
      props.onAgentCreated(created.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Agent 定义暂时无法导入');
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const confirmDelete = async () => {
    const agent = agents.find((item) => item.id === deleteAgentId);
    if (!agent || deleteConfirmation !== agent.name || deleting) return;
    setDeleting(true);
    try {
      await deleteAgent(agent.id);
      setDeleteAgentId(null);
      setDeleteConfirmation('');
      notify(`已删除 ${agent.name} 及其关联会话`);
      props.onAgentDeleted(agent.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Agent 暂时无法删除');
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!deleteAgentId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) setDeleteAgentId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteAgentId, deleting]);

  const deleteTarget = agents.find((agent) => agent.id === deleteAgentId);

  return (
    <>
      <nav className={cx('sidebar', collapsed && 'collapsed')} aria-label="侧边栏">
        <div className="sidebar-brand-row">
          <div className="sidebar-fold workspace-wrap" ref={workspaceRef}>
            <button
              type="button"
              className="workspace-button"
              onClick={() => setWorkspaceOpen((open) => !open)}
              aria-expanded={workspaceOpen}
              aria-label="工作区"
            >
              <span className="workspace-mark" aria-hidden="true">
                π
              </span>
              <span className="workspace-name">Waker 工作台</span>
              <CaretDown size={12} className="workspace-chevron" />
            </button>
            <AnimatePresence>
              {workspaceOpen && (
                <motion.div
                  className="workspace-popover"
                  role="dialog"
                  aria-label="工作区信息"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.15, ease: MOTION_EASE }}
                  style={{ transformOrigin: 'top left' }}
                >
                  <p className="workspace-popover-title">本地工作区</p>
                  <p className="workspace-popover-line">本地模式 · 无需登录</p>
                  {workspaceInfo && <p className="workspace-popover-line">{workspaceInfo}</p>}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={props.onToggleCollapsed}
            aria-label={collapsed ? '展开侧边栏 (⌘B)' : '收起侧边栏 (⌘B)'}
          >
            <SidebarSimple size={16} />
          </button>
        </div>

        <div className="sidebar-fold">
          <button
            type="button"
            className="sidebar-search"
            onClick={props.onOpenPalette}
            aria-label="搜索 (⌘K)"
          >
            <MagnifyingGlass size={12} />
            <span className="sidebar-search-placeholder">搜索…</span>
            <span className="search-kbd-group" aria-hidden="true">
              <kbd>⌘</kbd>
              <kbd>K</kbd>
            </span>
          </button>
        </div>

        <div className="sidebar-scroll" ref={agentMenuRef}>
          <button
            type="button"
            className={cx('nav-row', chatActive && 'active')}
            aria-current={chatActive ? 'page' : undefined}
            onClick={props.onCloseInbox}
            title="会话"
          >
            <NavIcon>
              <ChatCircle size={12} weight="bold" />
            </NavIcon>
            <span className="sidebar-fold">会话</span>
          </button>
          <button
            type="button"
            className={cx('nav-row', inboxOpen && 'active')}
            aria-current={inboxOpen ? 'page' : undefined}
            onClick={props.onOpenInbox}
            title="收件箱"
          >
            <NavIcon>
              <Tray size={12} weight="bold" />
            </NavIcon>
            <span className="sidebar-fold">收件箱</span>
            {inboxCount > 0 && (
              <span className="nav-badge" aria-label={`${inboxCount} 个未读会话`}>
                {inboxCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className="nav-row"
            onClick={props.onOpenShortcuts}
            title="键盘快捷键"
          >
            <NavIcon>
              <Keyboard size={12} weight="bold" />
            </NavIcon>
            <span className="sidebar-fold">快捷键</span>
          </button>

          <div className="sidebar-divider" role="separator" />

          <div className="group-header">
            <button
              type="button"
              className="group-header-toggle"
              onClick={() => setExploreOpen((open) => !open)}
              aria-expanded={exploreOpen}
            >
              <CaretDown
                size={12}
                className={cx('group-header-chevron', !exploreOpen && 'closed')}
              />
              <span className="group-header-label">探索</span>
            </button>
          </div>
          <AnimatePresence initial={false}>
            {exploreOpen && (
              <motion.div
                className="sidebar-group"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: MOTION_EASE }}
              >
                <button
                  type="button"
                  className={cx('nav-row', exploreView === 'agents' && 'active')}
                  aria-current={exploreView === 'agents' ? 'page' : undefined}
                  onClick={() => props.onOpenExplore('agents')}
                  title="Agents"
                >
                  <NavIcon>
                    <Users size={12} weight="bold" />
                  </NavIcon>
                  <span className="sidebar-fold">Agents</span>
                </button>
                <button
                  type="button"
                  className={cx('nav-row', exploreView === 'templates' && 'active')}
                  aria-current={exploreView === 'templates' ? 'page' : undefined}
                  onClick={() => props.onOpenExplore('templates')}
                  title="模板"
                >
                  <NavIcon>
                    <Layout size={12} weight="bold" />
                  </NavIcon>
                  <span className="sidebar-fold">模板</span>
                </button>
                <button
                  type="button"
                  className={cx('nav-row', exploreView === 'skills' && 'active')}
                  aria-current={exploreView === 'skills' ? 'page' : undefined}
                  onClick={() => props.onOpenExplore('skills')}
                  title="技能"
                >
                  <NavIcon>
                    <PuzzlePiece size={12} weight="bold" />
                  </NavIcon>
                  <span className="sidebar-fold">技能</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="sidebar-divider" role="separator" />

          <div className="group-header agent-create-wrap" ref={createMenuRef}>
            <button
              type="button"
              className="group-header-toggle"
              onClick={() => setAgentsOpen((open) => !open)}
              aria-expanded={agentsOpen}
            >
              <CaretDown
                size={12}
                className={cx('group-header-chevron', !agentsOpen && 'closed')}
              />
              <span className="group-header-label">我的 Agent</span>
            </button>
            <button
              type="button"
              className="group-add-button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setCreateMenuPosition({ top: rect.top, left: rect.right + 8 });
                setCreateMenuOpen((open) => !open);
              }}
              aria-expanded={createMenuOpen}
              aria-label="新建 Agent"
              title="新建 Agent"
            >
              <Plus size={12} weight="bold" />
            </button>
            <AnimatePresence>
              {createMenuOpen && (
                <motion.div
                  className="agent-create-menu"
                  role="menu"
                  aria-label="新建 Agent"
                  initial={{ opacity: 0, scale: 0.98, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: -4 }}
                  transition={{ duration: 0.15, ease: MOTION_EASE }}
                  style={createMenuPosition}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      setNewAgentOpen(true);
                    }}
                  >
                    <Plus size={16} />
                    <span>
                      <strong>新建 Agent</strong>
                      <small>创建一个空白定义</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      props.onOpenTemplates();
                    }}
                  >
                    <Layout size={16} />
                    <span>
                      <strong>从模板创建</strong>
                      <small>浏览内置模板</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => importInputRef.current?.click()}
                    disabled={importing}
                  >
                    <FileArrowUp size={16} />
                    <span>
                      <strong>导入</strong>
                      <small>上传 .md 定义文件</small>
                    </span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
            <input
              ref={importInputRef}
              hidden
              type="file"
              accept=".md,text/markdown,text/plain"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importDefinition(file);
                setCreateMenuOpen(false);
              }}
            />
          </div>
          <AnimatePresence initial={false}>
            {agentsOpen && (
              <motion.div
                className="sidebar-group"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: MOTION_EASE }}
              >
                {agents.map((agent) => (
                  <div className="agent-row-wrap" key={agent.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={cx('agent-row', agent.id === currentAgentId && 'active')}
                      title={agent.name}
                      onClick={() => props.onSelectAgent(agent.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') props.onSelectAgent(agent.id);
                      }}
                    >
                      <AgentChip mark={agent.mark} agentId={agent.id} hasAvatar={agent.hasAvatar} />
                      <span className="agent-name">{agent.name}</span>
                      {(attentionByAgent[agent.id] ?? 0) > 0 && (
                        <span
                          className="nav-badge agent-badge"
                          aria-label={`${attentionByAgent[agent.id]} 个会话需要处理`}
                        >
                          {attentionByAgent[agent.id]}
                        </span>
                      )}
                      <span className="agent-row-actions">
                        <button
                          type="button"
                          className="mini-button"
                          aria-label={`${agent.name} 更多操作`}
                          aria-expanded={agentMenuId === agent.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            const rect = event.currentTarget.getBoundingClientRect();
                            setAgentMenuPosition({ top: rect.top, left: rect.right + 8 });
                            setAgentMenuId((current) => (current === agent.id ? null : agent.id));
                          }}
                        >
                          <DotsThree size={14} weight="bold" />
                        </button>
                      </span>
                    </div>
                    <AnimatePresence>
                      {agentMenuId === agent.id && (
                        <motion.div
                          className="agent-action-menu"
                          role="menu"
                          aria-label={`${agent.name} 操作`}
                          initial={{ opacity: 0, scale: 0.98, y: -3 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.98, y: -3 }}
                          transition={{ duration: 0.12, ease: MOTION_EASE }}
                          style={agentMenuPosition}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAgentMenuId(null);
                              props.onOpenConfig(agent.id);
                            }}
                          >
                            <Info size={14} />
                            配置
                          </button>
                          <a
                            role="menuitem"
                            href={`/api/v1/agents/${encodeURIComponent(agent.id)}/source`}
                            download={`${agent.id}.md`}
                            onClick={() => setAgentMenuId(null)}
                          >
                            <DownloadSimple size={14} />
                            导出定义
                          </a>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            onClick={() => {
                              setAgentMenuId(null);
                              setDeleteConfirmation('');
                              setDeleteAgentId(agent.id);
                            }}
                          >
                            <Trash size={14} />
                            删除
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))}
                {!agents.length && (
                  <p className="sidebar-empty-hint">暂无 Agent，点右上角 + 从模板创建</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className={cx('nav-row', systemView === 'usage' && 'active')}
            aria-current={systemView === 'usage' ? 'page' : undefined}
            onClick={() => props.onOpenSystem('usage')}
            title="用量"
          >
            <NavIcon>
              <ChartLine size={12} weight="bold" />
            </NavIcon>
            <span className="sidebar-fold">用量</span>
          </button>
          <button
            type="button"
            className={cx('nav-row', systemView === 'settings' && 'active')}
            aria-current={systemView === 'settings' ? 'page' : undefined}
            onClick={() => props.onOpenSystem('settings')}
            title="设置"
          >
            <NavIcon>
              <GearSix size={12} weight="bold" />
            </NavIcon>
            <span className="sidebar-fold">设置</span>
          </button>
          <div
            className="account-row"
            title={`本地模式 · 无需登录${workspaceInfo ? ` · ${workspaceInfo}` : ''}`}
          >
            <span className="account-mark" aria-hidden="true">
              π
            </span>
            <span className="account-copy">
              <strong>本地模式</strong>
              <small>{workspaceInfo ?? '数据保存在本项目内'}</small>
            </span>
          </div>
        </div>
      </nav>
      <NewAgentDialog
        open={newAgentOpen}
        onClose={() => setNewAgentOpen(false)}
        hostName={workspace.host.name}
        onAvatarError={notify}
        onCreated={(agentId) => {
          setNewAgentOpen(false);
          notify('Agent 已创建');
          props.onAgentCreated(agentId);
        }}
      />
      <AnimatePresence>
        {deleteTarget && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !deleting) setDeleteAgentId(null);
            }}
          >
            <motion.div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-agent-title"
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
            >
              <div className="modal-head">
                <strong id="delete-agent-title">删除 Agent</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭"
                  onClick={() => setDeleteAgentId(null)}
                  disabled={deleting}
                >
                  <X size={14} />
                </button>
              </div>
              <p className="modal-hint">
                此操作会永久删除 <strong>{deleteTarget.name}</strong>
                、定义文件及全部关联会话，无法撤销。
              </p>
              <label className="modal-field">
                <span>输入 {deleteTarget.name} 以确认</span>
                <input
                  value={deleteConfirmation}
                  autoFocus
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  disabled={deleting}
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="header-button"
                  onClick={() => setDeleteAgentId(null)}
                  disabled={deleting}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="header-button danger"
                  onClick={() => void confirmDelete()}
                  disabled={deleting || deleteConfirmation !== deleteTarget.name}
                >
                  {deleting ? <CircleNotch size={13} className="spinning" /> : null}
                  删除
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
