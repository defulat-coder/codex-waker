import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSummary,
  SessionSummary,
  WorkspaceResponse,
  WakerProject,
} from '@waker/contracts';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { Folder } from '@phosphor-icons/react/dist/icons/Folder';
import { SlidersHorizontal } from '@phosphor-icons/react/dist/icons/SlidersHorizontal';
import {
  deleteSession,
  fetchInbox,
  fetchPreferences,
  fetchSessionMessages,
  fetchSessionContext,
  fetchSessions,
  fetchSettings,
  fetchUsage,
  fetchWorkspace,
  fetchLocalResources,
  renameSession,
  savePreference,
} from './lib/api.js';
import { cx } from './lib/cx.js';
import {
  buildInboxResumeText,
  INBOX_CONTINUE_TEXT,
  type InboxResumeMode,
} from './lib/inboxResume.js';
import { sortSessions } from './lib/sessions.js';
import type { ExploreView } from './lib/explore.js';
import type { SystemView, ViewState } from './lib/types.js';
import {
  mergeServerModelPreferences,
  mergeServerThinkingPreferences,
  readModelPreference,
} from './lib/configPanel.js';
import { MOTION_EASE } from './lib/motion.js';
import { MAX_TURN_ATTACHMENTS, type DraftComposerAttachment } from './lib/composerAttachments.js';
import {
  mergeServerUiPreferences,
  readUiPreferences,
  serverKeyForPreference,
  writeUiPreference,
  type UiPreferences,
} from './lib/preferences.js';
import { applyThemePreference } from './lib/theme.js';
import { useAsyncData } from './hooks/useAsyncData.js';
import { useChatController } from './hooks/useChatController.js';
import { useVisiblePolling } from './hooks/useVisiblePolling.js';
import { WorkspaceProvider } from './context/WorkspaceContext.js';
import { Toasts, type Toast } from './components/Toasts.js';
import { InboxColumn, type SessionFilter } from './components/InboxColumn.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ShortcutsModal } from './components/ShortcutsModal.js';
import type { PaletteAction } from './lib/palette.js';
import { UsageBar } from './components/UsageBar.js';
import { Welcome } from './components/Welcome.js';
import { Composer } from './components/Composer.js';
import { ThreadView } from './components/ThreadView.js';
import { TurnProgress } from './components/TurnProgress.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { FilesPanel } from './components/FilesPanel.js';
import { InboxView } from './components/InboxView.js';
import { ExploreAgents } from './components/ExploreAgents.js';
import { TemplatesView } from './components/TemplatesView.js';
import { SkillsView } from './components/SkillsView.js';
import { UsageView } from './components/UsageView.js';
import { SettingsView } from './components/SettingsView.js';
import { MemoryView } from './components/MemoryView.js';
import { WorkflowManager } from './components/WorkflowManager.js';
import { AutomationManager } from './components/AutomationManager.js';
import { BoardView } from './components/BoardView.js';
import { SessionOutputsPanel } from './components/SessionOutputsPanel.js';
import { StopTurnButton } from './components/StopTurnButton.js';
import { WakerOnboardingPanel } from './components/WakerOnboardingPanel.js';
import { ProjectManagementView } from './components/ProjectManagementView.js';
import { KnowledgeManagementView } from './components/KnowledgeManagementView.js';
import { WakerCapabilitiesView } from './components/WakerCapabilitiesView.js';
import { WakerHomeView } from './components/WakerHomeView.js';
import { WakerDetailNav, type WakerDetailNavKey } from './components/WakerDetailNav.js';
import {
  LegacyRail,
  ResourcesView,
  WakersView,
  type LegacyView,
} from './components/LegacyWorkbench.js';

/** toast 自动消失时长。 */
const TOAST_DURATION_MS = 4000;
/** 收件箱轮询间隔：仅页面可见时兜底刷新（无服务端推送通道）。 */
const INBOX_POLL_INTERVAL_MS = 60_000;

/** 显示 Waker 详情导航的视图：进入某个 Waker 的页面时在主导航与内容区之间渲染。 */
const DETAIL_NAV_VIEWS: ReadonlySet<LegacyView> = new Set([
  'waker-home',
  'projects',
  'tasks',
  'workflows',
  'memory',
  'skills',
  'knowledge',
  'capabilities',
  'im',
]);

/**
 * 页头会话标题（Fleet 实测结构）：逐字母 inline-block span 拆分，
 * variants stagger 逐个入场；reducedMotion 由全局 MotionConfig「user」接管。
 */
function HeaderTitle({ title }: { title: string }) {
  return (
    <motion.span
      className="thread-header-title"
      aria-label={title}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.02 } } }}
    >
      {[...title].map((char, index) => (
        <motion.span
          key={`${index}-${char}`}
          className="thread-header-title-char"
          aria-hidden="true"
          variants={{
            hidden: { opacity: 0, y: 4 },
            visible: { opacity: 1, y: 0 },
          }}
          transition={{ duration: 0.15, ease: MOTION_EASE }}
        >
          {char}
        </motion.span>
      ))}
    </motion.span>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [fatal, setFatal] = useState('');
  const [currentAgentId, setCurrentAgentId] = useState<string | undefined>(undefined);
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, SessionSummary[]>>({});
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(() => readUiPreferences());
  const [, setSidebarCollapsed] = useState(() => readUiPreferences().sidebarCollapsed);
  const [inboxColumnCollapsed, setInboxColumnCollapsed] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  /** 右侧 Files 面板开关（项目文件浏览器，与配置面板并列）。 */
  const [filesOpen, setFilesOpen] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  /** 主区域互斥视图：chat / inbox / explore / system 由 union 类型保证同一时刻只有一个。 */
  const [view, setView] = useState<ViewState>({ kind: 'chat' });
  const [legacyView, setLegacyView] = useState<LegacyView>('chat');
  const [taskSurface, setTaskSurface] = useState<'board' | 'automations'>('board');
  const [boardAutomationId, setBoardAutomationId] = useState<string | undefined>();
  const [boardWorkflowId, setBoardWorkflowId] = useState<string | undefined>();
  const [memoryAgentId, setMemoryAgentId] = useState<string | null>(null);
  const [capabilitiesAgentId, setCapabilitiesAgentId] = useState<string | null>(null);
  /** 详情导航「连接器/权限」深链的初始页签；seq 用于已挂载时强制重挂以切换页签。 */
  const [capabilitiesTab, setCapabilitiesTab] = useState<'connectors' | 'permissions'>(
    'connectors',
  );
  const [capabilitiesTabSeq, setCapabilitiesTabSeq] = useState(0);
  const [wakerHomeAgentId, setWakerHomeAgentId] = useState<string | null>(null);
  const [onboardingAgentId, setOnboardingAgentId] = useState<string | null>(null);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [draftAttachments, setDraftAttachments] = useState<DraftComposerAttachment[]>([]);
  const draftAttachmentsRef = useRef<DraftComposerAttachment[]>([]);
  draftAttachmentsRef.current = draftAttachments;
  const [projects, setProjects] = useState<WakerProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const toastTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // 卸载时清掉未决的 toast timer，避免卸载后 setState。
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** 用户可见的错误通知；到时自动消失。 */
  const notify = useCallback((text: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, text }]);
    const timer = setTimeout(() => {
      toastTimers.current.delete(timer);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
    toastTimers.current.add(timer);
  }, []);

  // 派生布尔值保持既有判断语义；写入一律走 setView。
  const inboxOpen = view.kind === 'inbox';
  const exploreView = view.kind === 'explore' ? view.view : null;
  const systemView = view.kind === 'system' ? view.view : null;

  const currentAgent: AgentSummary | undefined = workspace?.agents.find(
    (agent) => agent.id === currentAgentId,
  );
  /** Waker Home 目标 Agent；被删除时由 handleAgentDeleted 退回管理视图。 */
  const wakerHomeAgent: AgentSummary | undefined = workspace?.agents.find(
    (agent) => agent.id === wakerHomeAgentId,
  );
  const sessions = useMemo(
    () => (currentAgentId ? sortSessions(sessionsByAgent[currentAgentId] ?? []) : []),
    [sessionsByAgent, currentAgentId],
  );

  const inbox = useAsyncData(() => fetchInbox('attention'), {
    onError: () => notify('收件箱暂时无法读取'),
  });
  const usage = useAsyncData(fetchUsage);
  const settings = useAsyncData(fetchSettings);
  const { reload: reloadInbox } = inbox;
  const { reload: reloadSettings } = settings;

  // 60s 轮询兜底（仅页面可见时）；reload 身份稳定，与手动/onTurnSettled 刷新共用同一条路径。
  useVisiblePolling(() => void reloadInbox(), INBOX_POLL_INTERVAL_MS);

  const loadSessions = useCallback(
    async (agentId: string) => {
      try {
        const items = await fetchSessions(agentId);
        setSessionsByAgent((prev) => ({ ...prev, [agentId]: items }));
      } catch {
        notify('会话列表暂时无法读取');
      }
    },
    [notify],
  );

  const chat = useChatController({
    notify,
    onTurnSettled: (agentId) => {
      void loadSessions(agentId);
      void inbox.reload();
    },
  });

  const handlePreferenceChange = <K extends keyof UiPreferences>(
    key: K,
    value: UiPreferences[K],
  ) => {
    setUiPreferences((current) => writeUiPreference(current, key, value));
    void savePreference(serverKeyForPreference(key), value).catch(() => {
      // 服务端写穿失败时 localStorage 仍是权威缓存，但让用户知道没有持久化。
      notify('偏好已在本机生效，但未能同步到服务端');
    });
  };

  // 主题偏好立即落到 <html data-theme>；auto 时移除属性回退系统媒体查询。
  useEffect(() => {
    applyThemePreference(uiPreferences.theme);
  }, [uiPreferences.theme]);

  /** 服务端偏好（SQLite）覆盖本地缓存；本地读不到时保持默认。 */
  const loadPreferences = useCallback(async () => {
    try {
      const items = await fetchPreferences();
      const merged = mergeServerUiPreferences(items);
      setUiPreferences(merged);
      setSidebarCollapsed(merged.sidebarCollapsed);
      mergeServerThinkingPreferences(items);
      mergeServerModelPreferences(items);
    } catch {
      // 偏好服务不可用时沿用本地缓存。
    }
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const snapshot = await fetchWorkspace();
      setWorkspace(snapshot);
      const first = snapshot.agents[0];
      if (first) {
        setCurrentAgentId((prev) => prev ?? first.id);
        // 首个 Agent 也套用其默认模型偏好；无偏好则 undefined（服务端默认模型）。
        setSelectedModel((prev) => prev ?? readModelPreference(first.id));
        void loadSessions(first.id);
      }
      void reloadInbox();
      void reloadSettings();
      void loadPreferences();
    } catch (error) {
      setFatal(error instanceof Error ? error.message : '工作区信息暂时无法读取');
    }
  }, [loadSessions, loadPreferences, reloadInbox, reloadSettings]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const send = (
    text: string,
    attachments: DraftComposerAttachment[] = [],
    onAttachmentsSent?: () => void,
  ) => {
    if (!currentAgentId) return false;
    return chat.send(
      text,
      currentAgentId,
      selectedModel,
      undefined,
      selectedAttachmentIds,
      () => {
        setSelectedAttachmentIds([]);
        onAttachmentsSent?.();
      },
      selectedProjectId || undefined,
      attachments.map(({ originalName, mimeType, dataBase64 }) => ({
        originalName,
        mimeType,
        dataBase64,
      })),
    );
  };

  const clearDraftAttachments = useCallback(() => {
    for (const attachment of draftAttachmentsRef.current)
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    draftAttachmentsRef.current = [];
    setDraftAttachments([]);
  }, []);

  useEffect(
    () => () => {
      for (const attachment of draftAttachmentsRef.current)
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    },
    [],
  );

  const discardDraftAttachments = (reason: string) => {
    if (!draftAttachmentsRef.current.length) return;
    clearDraftAttachments();
    notify(reason);
  };

  const reloadProjects = useCallback(async () => {
    if (!currentAgentId) {
      setProjects([]);
      return;
    }
    try {
      const data = await fetchLocalResources(currentAgentId);
      const nextProjects = data.projects ?? [];
      setProjects(nextProjects);
      setSelectedProjectId((current) =>
        nextProjects.some((project) => project.id === current) ? current : '',
      );
    } catch {
      setProjects([]);
    }
  }, [currentAgentId]);

  useEffect(() => {
    setSelectedProjectId('');
    void reloadProjects();
  }, [currentAgentId, reloadProjects]);

  useEffect(() => {
    const sessionId = chat.currentSessionId;
    if (!currentAgentId || !sessionId || sessionId.startsWith('draft-')) return;
    void fetchSessionContext(currentAgentId, sessionId)
      .then((context) => setSelectedProjectId(context.projectId ?? ''))
      .catch(() => setSelectedProjectId(''));
  }, [chat.currentSessionId, currentAgentId]);

  /** 恢复卡「重试」：重发当前线程最后一条用户消息（沿用 composer 的会话/草稿推导，不传 targetSessionId）。 */
  const retryLastTurn = () => {
    const lastUser = [...chat.threadMessages].reverse().find((message) => message.role === 'user');
    if (lastUser) send(lastUser.text);
  };

  /** 恢复卡「继续」：发送固定文本让 Agent 接着回答。 */
  const continueLastTurn = () => send('请继续');

  const selectAgent = (agentId: string) => {
    if (agentId === currentAgentId && legacyView === 'chat' && !exploreView && !systemView) return;
    chat.interrupt();
    discardDraftAttachments('已清除原 Waker 中尚未发送的附件');
    setCurrentAgentId(agentId);
    // 切换 Agent 时重置为该 Agent 的默认模型偏好；Composer 内的手动选择只活到下次切换。
    setSelectedModel(readModelPreference(agentId));
    chat.closeSession();
    setConfigAgentId(null);
    setView({ kind: 'chat' });
    setLegacyView('chat');
    setSelectedAttachmentIds([]);
    setOutputsOpen(false);
    if (!sessionsByAgent[agentId]) void loadSessions(agentId);
  };

  const selectSession = (sessionId: string) => {
    if (sessionId === chat.currentSessionId && !exploreView && !systemView) return;
    setView({ kind: 'chat' });
    setLegacyView('chat');
    discardDraftAttachments('已清除上一会话中尚未发送的附件');
    if (currentAgentId) chat.openSession(currentAgentId, sessionId);
  };

  const newSession = () => {
    setView({ kind: 'chat' });
    setLegacyView('chat');
    chat.closeSession();
    discardDraftAttachments('已清除上一会话中尚未发送的附件');
    setConfigAgentId(null);
  };

  const openExplore = (target: ExploreView) => {
    setConfigAgentId(null);
    if (target === 'skills') {
      setLegacyView('skills');
      setView({ kind: 'chat' });
      return;
    }
    setView({ kind: 'explore', view: target });
  };

  const openSystem = (target: SystemView) => {
    setConfigAgentId(null);
    setView({ kind: 'system', view: target });
    if (target === 'usage') void usage.reload();
    else void settings.reload();
  };

  const openLegacy = (target: LegacyView) => {
    setLegacyView(target);
    setView({ kind: 'chat' });
    if (target === 'tasks') {
      setTaskSurface('board');
      setBoardAutomationId(undefined);
    }
    if (target === 'workflows') setBoardWorkflowId(undefined);
    setConfigAgentId(null);
    setFilesOpen(false);
    if (target === 'settings') void settings.reload();
  };

  /** 详情导航的 Agent 上下文：与管理卡片动作共用同一组 setter 写入。 */
  const detailNavAgentId =
    wakerHomeAgentId ?? capabilitiesAgentId ?? memoryAgentId ?? currentAgentId;
  const detailNavAgent = workspace?.agents.find((agent) => agent.id === detailNavAgentId);
  const showDetailNav = Boolean(detailNavAgent) && DETAIL_NAV_VIEWS.has(legacyView);
  /** 当前视图（+ 任务面板/能力页签）映射回导航键；ConfigPanel 为该 Agent 打开时设置高亮。 */
  const detailNavActive: WakerDetailNavKey | null = !showDetailNav
    ? null
    : configAgentId && configAgentId === detailNavAgentId
      ? 'settings'
      : legacyView === 'waker-home'
        ? 'home'
        : legacyView === 'projects'
          ? 'projects'
          : legacyView === 'tasks'
            ? taskSurface === 'automations'
              ? 'automations'
              : null
            : legacyView === 'workflows'
              ? 'workflows'
              : legacyView === 'memory'
                ? 'memory'
                : legacyView === 'skills'
                  ? 'skills'
                  : legacyView === 'knowledge'
                    ? 'knowledge'
                    : legacyView === 'capabilities'
                      ? capabilitiesTab === 'permissions'
                        ? 'permissions'
                        : 'connectors'
                      : legacyView === 'im'
                        ? 'im'
                        : null;

  /** 详情导航点击：先统一 Agent 上下文（复用卡片动作的 setter），再切目标视图。 */
  const navigateWakerDetail = (key: WakerDetailNavKey) => {
    const agentId = detailNavAgentId;
    if (!agentId) return;
    switch (key) {
      case 'home':
        setWakerHomeAgentId(agentId);
        setLegacyView('waker-home');
        break;
      case 'projects':
        selectAgent(agentId);
        setLegacyView('projects');
        break;
      case 'automations':
        selectAgent(agentId);
        setTaskSurface('automations');
        setLegacyView('tasks');
        break;
      case 'chat-tasks':
        selectAgent(agentId);
        break;
      case 'workflows':
        selectAgent(agentId);
        setLegacyView('workflows');
        break;
      case 'memory':
        setMemoryAgentId(agentId);
        setLegacyView('memory');
        break;
      case 'skills':
        setLegacyView('skills');
        break;
      case 'knowledge':
        selectAgent(agentId);
        setLegacyView('knowledge');
        break;
      case 'connectors':
        setCapabilitiesAgentId(agentId);
        setCapabilitiesTab('connectors');
        setCapabilitiesTabSeq((value) => value + 1);
        setLegacyView('capabilities');
        break;
      case 'im':
        selectAgent(agentId);
        setLegacyView('im');
        break;
      case 'permissions':
        setCapabilitiesAgentId(agentId);
        setCapabilitiesTab('permissions');
        setCapabilitiesTabSeq((value) => value + 1);
        setLegacyView('capabilities');
        break;
      case 'settings':
        setConfigAgentId(agentId);
        break;
    }
  };

  const handleAgentCreated = async (agentId: string) => {
    try {
      const snapshot = await fetchWorkspace();
      setWorkspace(snapshot);
      setCurrentAgentId(agentId);
      setSelectedModel(readModelPreference(agentId));
      setSessionsByAgent((current) => ({ ...current, [agentId]: [] }));
      chat.closeSession();
      setConfigAgentId(null);
      setView({ kind: 'chat' });
      setLegacyView('wakers');
      setOnboardingAgentId(agentId);
    } catch {
      // 刷新失败时下次进入页面再拉。
    }
  };

  const handleAgentDeleted = async (agentId: string) => {
    const snapshot = await fetchWorkspace().catch(() => null);
    if (!snapshot) return;
    setWorkspace(snapshot);
    setSessionsByAgent((current) => {
      const next = { ...current };
      delete next[agentId];
      return next;
    });
    if (currentAgentId === agentId) {
      chat.interrupt();
      chat.closeSession();
      const next = snapshot.agents[0];
      setCurrentAgentId(next?.id);
      setSelectedModel(next ? readModelPreference(next.id) : undefined);
    }
    if (onboardingAgentId === agentId) setOnboardingAgentId(null);
    if (wakerHomeAgentId === agentId) {
      setWakerHomeAgentId(null);
      setLegacyView('wakers');
    }
  };

  const reloadWorkspace = useCallback(() => {
    fetchWorkspace()
      .then(setWorkspace)
      .catch(() => {
        // 刷新失败时下次进入页面再拉。
      });
  }, []);

  const openInboxItem = (agentId: string, sessionId: string) => {
    setView({ kind: 'chat' });
    setLegacyView('chat');
    discardDraftAttachments('已清除上一会话中尚未发送的附件');
    if (agentId !== currentAgentId) {
      chat.interrupt();
      setCurrentAgentId(agentId);
      if (!sessionsByAgent[agentId]) void loadSessions(agentId);
    }
    setConfigAgentId(null);
    chat.openSession(agentId, sessionId);
  };

  /**
   * 收件箱「恢复闭环」：先把会话打开到聊天视图，再就地发起一轮——
   * retry 重发该会话最后一条用户消息，continue 发固定文本「请继续」。
   * 成功后由 onTurnSettled 触发收件箱刷新，后端自动转 Completed。
   */
  const handleInboxResume = async (agentId: string, sessionId: string, mode: InboxResumeMode) => {
    // 先清掉可能进行中的 turn：否则 send 会被 liveTurn 守卫吞掉（openInboxItem 只在跨 Agent 时 interrupt）。
    chat.interrupt();
    openInboxItem(agentId, sessionId);
    let text: string | null = INBOX_CONTINUE_TEXT;
    if (mode === 'retry') {
      text = await fetchSessionMessages(agentId, sessionId)
        .then((messages) => buildInboxResumeText(messages, 'retry'))
        .catch(() => null);
    }
    if (!text) {
      notify('没有可重试的消息');
      return;
    }
    chat.send(text, agentId, selectedModel, sessionId);
  };

  /** 收件箱内变更（已读/删除）后：刷新徽标数据，并同步当前 Agent 的会话列表。 */
  const handleInboxChanged = () => {
    void reloadInbox();
    if (currentAgentId) void loadSessions(currentAgentId);
  };

  const handlePaletteAction = (action: PaletteAction) => {
    switch (action.kind) {
      case 'chat':
        setView({ kind: 'chat' });
        break;
      case 'inbox':
        setView({ kind: 'inbox' });
        void inbox.reload();
        break;
      case 'explore':
        openExplore(action.view);
        break;
      case 'system':
        openSystem(action.view);
        break;
      case 'agent':
        selectAgent(action.agentId);
        break;
      case 'session':
        openInboxItem(action.agentId, action.sessionId);
        break;
    }
  };

  const handleRename = async (sessionId: string, title: string) => {
    if (!currentAgentId) return;
    try {
      await renameSession(currentAgentId, sessionId, title);
      await loadSessions(currentAgentId);
    } catch {
      notify('会话名称暂时无法保存');
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!currentAgentId) return;
    try {
      await deleteSession(currentAgentId, sessionId);
      chat.removeThread(sessionId);
      await loadSessions(currentAgentId);
      void inbox.reload();
    } catch {
      notify('会话暂时无法删除');
    }
  };

  if (fatal) {
    return (
      <div className="app-shell">
        <main className="app-fatal">
          <p>Waker 加载失败。</p>
          <p className="app-fatal-detail">{fatal}</p>
          <button
            type="button"
            onClick={() => {
              setFatal('');
              void bootstrap();
            }}
          >
            重试
          </button>
        </main>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="app-shell">
        <main className="app-loading" aria-live="polite">
          正在加载 Waker...
        </main>
      </div>
    );
  }

  const showWelcome = !chat.currentSessionId;
  /** 当前会话标题：草稿会话尚未入列表时为空，页头/内容区标题均不渲染。 */
  const currentSessionTitle = sessions.find(
    (session) => session.id === chat.currentSessionId,
  )?.title;
  /** 视图级 key：只有跨视图切换才重放入场动画，Agent/会话切换不重挂载主区。 */
  const viewKey = exploreView
    ? `explore-${exploreView}`
    : systemView
      ? `system-${systemView}`
      : inboxOpen
        ? 'inbox'
        : 'chat';

  const chatVisible = legacyView === 'chat';

  return (
    <WorkspaceProvider value={{ workspace, sessionsByAgent, notify, reloadWorkspace }}>
      <MotionConfig reducedMotion="user">
        <div className="app-shell" data-direction-contract="legacy-qoderwake-0.4.2">
          <LegacyRail
            active={legacyView}
            unreadCount={inbox.data?.unreadCount ?? 0}
            onChange={openLegacy}
          />

          {showDetailNav && detailNavAgent && (
            <WakerDetailNav
              agentName={detailNavAgent.name}
              active={detailNavActive}
              onBack={() => setLegacyView('wakers')}
              onNavigate={navigateWakerDetail}
            />
          )}

          {chatVisible && !exploreView && !systemView && !inboxOpen && currentAgent && (
            <InboxColumn
              title={currentAgent.name}
              sessions={sessions}
              currentSessionId={chat.currentSessionId}
              runningSessionId={chat.liveTurn ? chat.currentSessionId : null}
              filter={sessionFilter}
              collapsed={inboxColumnCollapsed}
              onToggleCollapsed={() => setInboxColumnCollapsed((value) => !value)}
              onSelectSession={selectSession}
              onRenameSession={(id, title) => void handleRename(id, title)}
              onDeleteSession={(id) => void handleDelete(id)}
              onFilterChange={setSessionFilter}
            />
          )}

          <main className="main-area">
            {/* 视图切换入场淡入：key 到视图级，切换即时（无 exit），不随 Agent/会话变化重挂载 */}
            <motion.div
              key={viewKey}
              className="view-body"
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: MOTION_EASE }}
            >
              {chatVisible && !exploreView && !systemView && !inboxOpen && (
                <UsageBar agent={currentAgent} sessions={sessions} />
              )}

              {legacyView === 'wakers' ? (
                <WakersView
                  agents={workspace.agents}
                  hostName={workspace.host.name}
                  onboarding={
                    onboardingAgentId ? (
                      <WakerOnboardingPanel
                        onChat={() => {
                          const agentId = onboardingAgentId;
                          setOnboardingAgentId(null);
                          selectAgent(agentId);
                        }}
                        onKnowledge={() => {
                          setOnboardingAgentId(null);
                          setLegacyView('knowledge');
                        }}
                        onProject={() => {
                          setOnboardingAgentId(null);
                          setLegacyView('projects');
                        }}
                        onDismiss={() => setOnboardingAgentId(null)}
                      />
                    ) : undefined
                  }
                  onChat={selectAgent}
                  onConfigure={setConfigAgentId}
                  onOpenHome={(agentId) => {
                    setWakerHomeAgentId(agentId);
                    setLegacyView('waker-home');
                  }}
                  onMemory={(agentId) => {
                    setMemoryAgentId(agentId);
                    setLegacyView('memory');
                  }}
                  onCapabilities={(agentId) => {
                    setCapabilitiesAgentId(agentId);
                    setCapabilitiesTab('connectors');
                    setLegacyView('capabilities');
                  }}
                  onAutomation={(agentId) => {
                    selectAgent(agentId);
                    setTaskSurface('automations');
                    setLegacyView('tasks');
                  }}
                  onCreated={(agentId) => void handleAgentCreated(agentId)}
                  onDeleted={(agentId) => void handleAgentDeleted(agentId)}
                  onReadAll={() => {
                    reloadWorkspace();
                    void reloadInbox();
                  }}
                  notify={notify}
                />
              ) : legacyView === 'waker-home' && wakerHomeAgent ? (
                <WakerHomeView
                  agent={wakerHomeAgent}
                  onEdit={() => setConfigAgentId(wakerHomeAgent.id)}
                />
              ) : legacyView === 'capabilities' && capabilitiesAgentId ? (
                <WakerCapabilitiesView
                  key={`${capabilitiesAgentId}:${capabilitiesTabSeq}`}
                  wakerId={capabilitiesAgentId}
                  initialTab={capabilitiesTab}
                  onClose={() => setLegacyView('wakers')}
                  notify={notify}
                />
              ) : legacyView === 'memory' && memoryAgentId ? (
                <MemoryView
                  wakerId={memoryAgentId}
                  onClose={() => setLegacyView('wakers')}
                  notify={notify}
                />
              ) : legacyView === 'knowledge' ? (
                <KnowledgeManagementView wakerId={currentAgentId} notify={notify} />
              ) : legacyView === 'skills' ? (
                <SkillsView />
              ) : legacyView === 'projects' ? (
                currentAgentId ? (
                  <ProjectManagementView
                    wakerId={currentAgentId}
                    notify={notify}
                    onChanged={() => void reloadProjects()}
                  />
                ) : (
                  <div className="legacy-page">
                    <p>请先创建一个 Waker。</p>
                  </div>
                )
              ) : legacyView === 'workflows' ? (
                currentAgentId ? (
                  <WorkflowManager
                    wakerId={currentAgentId}
                    notify={notify}
                    onOpenSession={selectSession}
                    initialWorkflowId={boardWorkflowId}
                  />
                ) : (
                  <div className="legacy-page">
                    <p>请先创建一个 Waker。</p>
                  </div>
                )
              ) : legacyView === 'tasks' ? (
                currentAgentId ? (
                  taskSurface === 'automations' ? (
                    <div className="legacy-page">
                      <div className="page-actions">
                        <button
                          className="legacy-button"
                          type="button"
                          onClick={() => setTaskSurface('board')}
                        >
                          返回任务看板
                        </button>
                      </div>
                      <AutomationManager
                        wakerId={currentAgentId}
                        notify={notify}
                        onOpenSession={selectSession}
                        initialAutomationId={boardAutomationId}
                      />
                    </div>
                  ) : (
                    <BoardView
                      wakerId={currentAgentId}
                      notify={notify}
                      onOpenSession={selectSession}
                      onOpenAutomation={(automationId) => {
                        setBoardAutomationId(automationId);
                        setTaskSurface('automations');
                      }}
                      onOpenWorkflow={(workflowId) => {
                        setBoardWorkflowId(workflowId);
                        setLegacyView('workflows');
                      }}
                    />
                  )
                ) : (
                  <div className="legacy-page">
                    <p>请先创建一个 Waker。</p>
                  </div>
                )
              ) : legacyView === 'im' ? (
                <ResourcesView kind="im" wakerId={currentAgentId} notify={notify} />
              ) : legacyView === 'settings' ? (
                <SettingsView
                  settings={settings.data}
                  loading={settings.loading}
                  preferences={uiPreferences}
                  onPreferenceChange={handlePreferenceChange}
                />
              ) : exploreView === 'agents' ? (
                <ExploreAgents onOpenChat={selectAgent} />
              ) : exploreView === 'templates' ? (
                <TemplatesView onCreated={(agentId) => void handleAgentCreated(agentId)} />
              ) : exploreView === 'skills' ? (
                <SkillsView />
              ) : systemView === 'usage' ? (
                <UsageView
                  usage={usage.data}
                  loading={usage.loading}
                  onRefresh={() => void usage.reload()}
                />
              ) : systemView === 'settings' ? (
                <SettingsView
                  settings={settings.data}
                  loading={settings.loading}
                  preferences={uiPreferences}
                  onPreferenceChange={handlePreferenceChange}
                />
              ) : inboxOpen ? (
                <InboxView
                  onOpen={openInboxItem}
                  onResume={(agentId, sessionId, mode) =>
                    void handleInboxResume(agentId, sessionId, mode)
                  }
                  onInboxChanged={handleInboxChanged}
                />
              ) : (
                <>
                  {!showWelcome && (
                    <div className="thread-header">
                      {currentSessionTitle && (
                        <HeaderTitle key={currentSessionTitle} title={currentSessionTitle} />
                      )}
                      <button type="button" className="header-button primary" onClick={newSession}>
                        <Plus size={13} weight="bold" />
                        新会话
                      </button>
                      <button
                        type="button"
                        className={cx('header-button', filesOpen && 'active')}
                        onClick={() => setFilesOpen((prev) => !prev)}
                      >
                        <Folder size={13} />
                        文件
                      </button>
                      <label className="chat-project-select">
                        项目
                        <select
                          aria-label="对话项目"
                          value={selectedProjectId}
                          onChange={(event) => setSelectedProjectId(event.target.value)}
                        >
                          <option value="">当前仓库根（由服务端控制）</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className={cx('header-button', outputsOpen && 'active')}
                        onClick={() => setOutputsOpen((value) => !value)}
                      >
                        附件与结果
                        {selectedAttachmentIds.length + draftAttachments.length
                          ? ` (${selectedAttachmentIds.length + draftAttachments.length})`
                          : ''}
                      </button>
                      {currentAgentId && (
                        <button
                          type="button"
                          className={cx('header-button', configAgentId && 'active')}
                          onClick={() => setConfigAgentId((prev) => (prev ? null : currentAgentId))}
                        >
                          <SlidersHorizontal size={13} />
                          配置
                        </button>
                      )}
                    </div>
                  )}

                  {/* Welcome 淡出完成后再挂载会话区，避免两棵子树共存撑开布局 */}
                  <AnimatePresence mode="wait" initial={false}>
                    {showWelcome && currentAgent ? (
                      <motion.div
                        key="welcome"
                        className="chat-branch"
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15, ease: MOTION_EASE }}
                      >
                        <Welcome agent={currentAgent} onSuggestion={send} />
                        <div className="draft-outputs-note" role="note">
                          <span>
                            可使用输入框下方的回形针、拖放或粘贴，附件会随首轮对话一起保存。
                          </span>
                        </div>
                        <label className="draft-project-select">
                          工作目录
                          <select
                            aria-label="新会话项目"
                            value={selectedProjectId}
                            onChange={(event) => setSelectedProjectId(event.target.value)}
                          >
                            <option value="">当前仓库根（由服务端控制）</option>
                            {projects.map((project) => (
                              <option key={project.id} value={project.id}>
                                {project.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="composer-wrap welcome-composer">
                          <Composer
                            disabled={Boolean(chat.liveTurn)}
                            selectedModel={selectedModel}
                            onSelectModel={setSelectedModel}
                            onSend={send}
                            attachments={draftAttachments}
                            onAttachmentsChange={setDraftAttachments}
                            maxAttachments={MAX_TURN_ATTACHMENTS - selectedAttachmentIds.length}
                          />
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div key="thread" className="chat-branch">
                        <ThreadView
                          messages={chat.threadMessages}
                          compact={uiPreferences.compactMessages}
                          title={currentSessionTitle}
                          agentName={currentAgent?.name}
                          onRetry={chat.liveTurn ? undefined : retryLastTurn}
                          onContinue={chat.liveTurn ? undefined : continueLastTurn}
                          onOpenOutputs={
                            chat.currentSessionId?.startsWith('draft-')
                              ? undefined
                              : () => setOutputsOpen(true)
                          }
                        />
                        <div className="composer-wrap">
                          <div className="composer-inner">
                            {chat.liveTurn && <TurnProgress turn={chat.liveTurn} />}
                            {chat.liveTurn && <StopTurnButton running onStop={chat.interrupt} />}
                            <Composer
                              disabled={Boolean(chat.liveTurn)}
                              selectedModel={selectedModel}
                              onSelectModel={setSelectedModel}
                              onSend={send}
                              attachments={draftAttachments}
                              onAttachmentsChange={setDraftAttachments}
                              maxAttachments={MAX_TURN_ATTACHMENTS - selectedAttachmentIds.length}
                            />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </motion.div>
          </main>

          <AnimatePresence>
            {paletteOpen && (
              <CommandPalette
                open={paletteOpen}
                onAction={handlePaletteAction}
                onClose={() => setPaletteOpen(false)}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {shortcutsOpen && (
              <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {filesOpen && <FilesPanel onClose={() => setFilesOpen(false)} />}
          </AnimatePresence>

          {outputsOpen && currentAgentId && chat.currentSessionId && (
            <SessionOutputsPanel
              agentId={currentAgentId}
              sessionId={chat.currentSessionId}
              selectedIds={selectedAttachmentIds}
              maxSelected={MAX_TURN_ATTACHMENTS - draftAttachments.length}
              onToggle={(id) =>
                setSelectedAttachmentIds((current) =>
                  current.includes(id)
                    ? current.filter((item) => item !== id)
                    : current.length < MAX_TURN_ATTACHMENTS - draftAttachments.length
                      ? [...current, id]
                      : current,
                )
              }
              onClose={() => setOutputsOpen(false)}
              notify={notify}
            />
          )}

          <AnimatePresence>
            {configAgentId && (
              <ConfigPanel
                agentId={configAgentId}
                onClose={() => setConfigAgentId(null)}
                onUseSuggestion={(text) => {
                  setConfigAgentId(null);
                  send(text);
                }}
              />
            )}
          </AnimatePresence>

          <Toasts toasts={toasts} />
        </div>
      </MotionConfig>
    </WorkspaceProvider>
  );
}
