import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSummary,
  SessionSummary,
  WorkspaceResponse,
  WakerProject,
} from '@waker/contracts';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/icons/ClockCounterClockwise';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import {
  fetchInbox,
  fetchPreferences,
  fetchSessionContext,
  fetchSessions,
  fetchSettings,
  fetchUsage,
  fetchWorkspace,
  fetchLocalResources,
  markAllInboxRead,
  savePreference,
} from './lib/api.js';
import { sortSessions } from './lib/sessions.js';
import {
  mergeServerModelPreferences,
  mergeServerThinkingPreferences,
  readModelPreference,
} from './lib/configPanel.js';
import { MOTION_LAYOUT_TRANSITION, MOTION_TRANSITION } from './lib/motion.js';
import { MAX_TURN_ATTACHMENTS, type DraftComposerAttachment } from './lib/composerAttachments.js';
import {
  mergeServerUiPreferences,
  readUiPreferences,
  serverKeyForPreference,
  writeUiPreference,
  type UiPreferences,
} from './lib/preferences.js';
import { applyThemePreference } from './lib/theme.js';
import { readableErrorMessage } from './lib/errors.js';
import { useAsyncData } from './hooks/useAsyncData.js';
import { useChatController } from './hooks/useChatController.js';
import { useVisiblePolling } from './hooks/useVisiblePolling.js';
import { WorkspaceProvider } from './context/WorkspaceContext.js';
import { Toasts, type Toast, type ToastTone } from './components/Toasts.js';
import { Welcome } from './components/Welcome.js';
import { Composer } from './components/Composer.js';
import { ThreadView } from './components/ThreadView.js';
import { TurnProgress } from './components/TurnProgress.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { AgentChip } from './components/AgentChip.js';
import { QoderChatSidebar } from './components/QoderChatSidebar.js';
import { QoderTaskPanel } from './components/QoderTaskPanel.js';
import { SessionOutputsPanel } from './components/SessionOutputsPanel.js';
import { StopTurnButton } from './components/StopTurnButton.js';
import { WakerOnboardingPanel } from './components/WakerOnboardingPanel.js';
import { WakerDetailNav, type WakerDetailNavKey } from './components/WakerDetailNav.js';
import { MotionLoadingRows, MotionSpinner } from './components/MotionFeedback.js';
import {
  LegacyRail,
  ResourcesView,
  WakersView,
  type LegacyView,
} from './components/LegacyWorkbench.js';

const SkillsView = lazy(() =>
  import('./components/SkillsView.js').then(({ SkillsView }) => ({ default: SkillsView })),
);
const UsageView = lazy(() =>
  import('./components/UsageView.js').then(({ UsageView }) => ({ default: UsageView })),
);
const SettingsView = lazy(() =>
  import('./components/SettingsView.js').then(({ SettingsView }) => ({ default: SettingsView })),
);
const MemoryView = lazy(() =>
  import('./components/MemoryView.js').then(({ MemoryView }) => ({ default: MemoryView })),
);
const WorkflowManager = lazy(() =>
  import('./components/WorkflowManager.js').then(({ WorkflowManager }) => ({
    default: WorkflowManager,
  })),
);
const AutomationManager = lazy(() =>
  import('./components/AutomationManager.js').then(({ AutomationManager }) => ({
    default: AutomationManager,
  })),
);
const BoardView = lazy(() =>
  import('./components/BoardView.js').then(({ BoardView }) => ({ default: BoardView })),
);
const ProjectManagementView = lazy(() =>
  import('./components/ProjectManagementView.js').then(({ ProjectManagementView }) => ({
    default: ProjectManagementView,
  })),
);
const KnowledgeManagementView = lazy(() =>
  import('./components/KnowledgeManagementView.js').then(({ KnowledgeManagementView }) => ({
    default: KnowledgeManagementView,
  })),
);
const WakerCapabilitiesView = lazy(() =>
  import('./components/WakerCapabilitiesView.js').then(({ WakerCapabilitiesView }) => ({
    default: WakerCapabilitiesView,
  })),
);
const WakerHomeView = lazy(() =>
  import('./components/WakerHomeView.js').then(({ WakerHomeView }) => ({
    default: WakerHomeView,
  })),
);

/** toast 自动消失时长。 */
const TOAST_DURATION_MS = 4000;
const ERROR_TOAST_DURATION_MS = 8000;
/** 收件箱轮询间隔：仅页面可见时兜底刷新（无服务端推送通道）。 */
const INBOX_POLL_INTERVAL_MS = 60_000;

function ViewLoading() {
  return (
    <div className="legacy-page">
      <MotionLoadingRows count={3} label="正在打开页面" />
    </div>
  );
}

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

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [fatal, setFatal] = useState('');
  const [currentAgentId, setCurrentAgentId] = useState<string | undefined>(undefined);
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, SessionSummary[]>>({});
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(() => readUiPreferences());
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [legacyView, setLegacyView] = useState<LegacyView>('wakers');
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
  const outputsTriggerIdRef = useRef('');
  const [taskListOpen, setTaskListOpen] = useState(false);
  const taskListTriggerRef = useRef<HTMLButtonElement>(null);
  const [composerResetSignal, setComposerResetSignal] = useState(0);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [draftAttachments, setDraftAttachments] = useState<DraftComposerAttachment[]>([]);
  const draftAttachmentsRef = useRef<DraftComposerAttachment[]>([]);
  draftAttachmentsRef.current = draftAttachments;
  const [projects, setProjects] = useState<WakerProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [sessionContextLoading, setSessionContextLoading] = useState(false);
  const [projectContextError, setProjectContextError] = useState('');
  const projectLoadGenerationRef = useRef(0);
  const sessionContextGenerationRef = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const toastTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const markingAllReadRef = useRef(false);

  // 卸载时清掉未决的 toast timer，避免卸载后 setState。
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  /** 用户可见的操作通知；错误保留更久，也可由用户立即关闭。 */
  const notify = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, text, tone }]);
    const timer = setTimeout(
      () => {
        toastTimers.current.delete(id);
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      },
      tone === 'error' ? ERROR_TOAST_DURATION_MS : TOAST_DURATION_MS,
    );
    toastTimers.current.set(id, timer);
  }, []);

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
    onError: () => notify('收件箱暂时无法读取', 'error'),
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
        notify('会话列表暂时无法读取', 'error');
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
      notify('偏好已在本机生效，但未能同步到服务端', 'error');
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
      setFatal(readableErrorMessage(error, '工作区信息暂时无法读取'));
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

  const resetProjectContext = useCallback((clearProjects = false) => {
    sessionContextGenerationRef.current += 1;
    setSelectedProjectId('');
    setSessionContextLoading(false);
    setProjectContextError('');
    if (clearProjects) setProjects([]);
  }, []);

  const reloadProjects = useCallback(async () => {
    const generation = ++projectLoadGenerationRef.current;
    if (!currentAgentId) {
      setProjects([]);
      setProjectsLoading(false);
      return;
    }
    setProjectsLoading(true);
    setProjectContextError('');
    try {
      const data = await fetchLocalResources(currentAgentId);
      if (generation !== projectLoadGenerationRef.current) return;
      const nextProjects = data.projects ?? [];
      setProjects(nextProjects);
      setSelectedProjectId((current) =>
        nextProjects.some((project) => project.id === current) ? current : '',
      );
    } catch {
      if (generation !== projectLoadGenerationRef.current) return;
      setProjects([]);
      setProjectContextError('项目列表暂时无法读取');
    } finally {
      if (generation === projectLoadGenerationRef.current) setProjectsLoading(false);
    }
  }, [currentAgentId]);

  useEffect(() => {
    resetProjectContext();
    void reloadProjects();
  }, [currentAgentId, reloadProjects, resetProjectContext]);

  useEffect(() => {
    const sessionId = chat.currentSessionId;
    const generation = ++sessionContextGenerationRef.current;
    if (!currentAgentId || !sessionId || sessionId.startsWith('draft-')) {
      setSessionContextLoading(false);
      return;
    }
    setSessionContextLoading(true);
    setProjectContextError('');
    void fetchSessionContext(currentAgentId, sessionId)
      .then((context) => {
        if (generation === sessionContextGenerationRef.current)
          setSelectedProjectId(context.projectId ?? '');
      })
      .catch(() => {
        if (generation !== sessionContextGenerationRef.current) return;
        setSelectedProjectId('');
        setProjectContextError('会话项目上下文暂时无法读取');
      })
      .finally(() => {
        if (generation === sessionContextGenerationRef.current) setSessionContextLoading(false);
      });
  }, [chat.currentSessionId, currentAgentId]);

  /** 恢复卡「重试」：重发当前线程最后一条用户消息（沿用 composer 的会话/草稿推导，不传 targetSessionId）。 */
  const retryLastTurn = () => {
    const lastUser = [...chat.threadMessages].reverse().find((message) => message.role === 'user');
    if (lastUser) send(lastUser.text);
  };

  /** 恢复卡「继续」：发送固定文本让 Agent 接着回答。 */
  const continueLastTurn = () => send('请继续');

  const selectAgent = (agentId: string) => {
    if (agentId === currentAgentId && legacyView === 'chat') return;
    chat.interrupt();
    discardDraftAttachments('已清除原 Waker 中尚未发送的附件');
    setComposerResetSignal((value) => value + 1);
    resetProjectContext(true);
    setCurrentAgentId(agentId);
    // 切换 Agent 时重置为该 Agent 的默认模型偏好；Composer 内的手动选择只活到下次切换。
    setSelectedModel(readModelPreference(agentId));
    chat.closeSession();
    setConfigAgentId(null);
    setLegacyView('chat');
    setSelectedAttachmentIds([]);
    setOutputsOpen(false);
    setTaskListOpen(false);
    if (!sessionsByAgent[agentId]) void loadSessions(agentId);
  };

  const selectSession = (sessionId: string) => {
    if (sessionId === chat.currentSessionId) return;
    setLegacyView('chat');
    discardDraftAttachments('已清除上一会话中尚未发送的附件');
    setComposerResetSignal((value) => value + 1);
    resetProjectContext();
    if (currentAgentId) chat.openSession(currentAgentId, sessionId);
  };

  const newSession = () => {
    setLegacyView('chat');
    chat.closeSession();
    discardDraftAttachments('已清除上一会话中尚未发送的附件');
    setComposerResetSignal((value) => value + 1);
    resetProjectContext();
    setConfigAgentId(null);
  };

  const openLegacy = (target: LegacyView) => {
    setLegacyView(target);
    if (target !== 'chat') setTaskListOpen(false);
    setWakerHomeAgentId(null);
    setCapabilitiesAgentId(null);
    setMemoryAgentId(null);
    if (target === 'tasks') {
      setTaskSurface('board');
      setBoardAutomationId(undefined);
    }
    if (target === 'workflows') setBoardWorkflowId(undefined);
    setConfigAgentId(null);
    if (target === 'settings') void settings.reload();
    if (target === 'usage') void usage.reload();
  };

  /** 详情导航的 Agent 上下文：与管理卡片动作共用同一组 setter 写入。 */
  const detailNavAgentId =
    wakerHomeAgentId ?? capabilitiesAgentId ?? memoryAgentId;
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

  const handleMarkAllRead = useCallback(async () => {
    if (markingAllReadRef.current) return;
    markingAllReadRef.current = true;
    setMarkingAllRead(true);
    try {
      await markAllInboxRead();
      setWorkspace((current) =>
        current
          ? {
              ...current,
              agents: current.agents.map((agent) => ({ ...agent, unreadCount: 0 })),
            }
          : current,
      );
      notify('全部会话已标为已读', 'success');
      reloadWorkspace();
      void reloadInbox();
    } catch {
      notify('一键已读失败，请重试', 'error');
    } finally {
      markingAllReadRef.current = false;
      setMarkingAllRead(false);
    }
  }, [notify, reloadInbox, reloadWorkspace]);

  if (fatal) {
    return (
      <div className="app-shell">
        <main className="app-fatal" role="alert">
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
        <main className="app-loading" role="status" aria-live="polite" aria-busy="true">
          <MotionSpinner>
            <CircleNotch size={16} />
          </MotionSpinner>
          <span>正在加载 Waker...</span>
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
  const viewKey = legacyView;

  const chatVisible = legacyView === 'chat';
  const selectedProjectName = projects.find((project) => project.id === selectedProjectId)?.name;
  const projectContextBusy = projectsLoading || sessionContextLoading;
  const projectContextLabel = projectsLoading
    ? '正在读取项目…'
    : sessionContextLoading
      ? '正在恢复项目…'
      : projectContextError
        ? '项目上下文不可用'
        : (selectedProjectName ?? '选择工作目录');

  return (
    <WorkspaceProvider value={{ workspace, sessionsByAgent, notify, reloadWorkspace }}>
      <MotionConfig reducedMotion="user">
        <div className="app-shell" data-direction-contract="legacy-qoderwake-0.4.2">
          <LegacyRail
            active={legacyView}
            unreadCount={inbox.data?.unreadCount ?? 0}
            onChange={openLegacy}
          />

          <AnimatePresence initial={false}>
            {showDetailNav && detailNavAgent && (
              <WakerDetailNav
                key="waker-detail-nav"
                agentName={detailNavAgent.name}
                active={detailNavActive}
                onBack={() => setLegacyView('wakers')}
                onNavigate={navigateWakerDetail}
              />
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {chatVisible && currentAgent && (
              <QoderChatSidebar
                key="chat-sidebar"
                agents={workspace.agents}
                currentAgentId={currentAgent.id}
                onSelectAgent={selectAgent}
                markingAllRead={markingAllRead}
                onMarkAllRead={() => void handleMarkAllRead()}
              />
            )}
          </AnimatePresence>

          <motion.main
            className="main-area"
            layout
            transition={{ layout: MOTION_LAYOUT_TRANSITION }}
          >
            {chatVisible && currentAgent && (
              <header className="qoder-chat-header">
                <button
                  type="button"
                  className="qoder-chat-agent"
                  aria-label="查看 Waker 详情"
                  onClick={() => {
                    setWakerHomeAgentId(currentAgent.id);
                    setLegacyView('waker-home');
                  }}
                >
                  <AgentChip
                    mark={currentAgent.mark}
                    className="qoder-chat-header-avatar"
                    agentId={currentAgent.id}
                    hasAvatar={currentAgent.hasAvatar}
                  />
                  <strong>{currentAgent.name}</strong>
                  <span aria-hidden="true">›</span>
                </button>
                <div className="qoder-chat-header-actions">
                  <button type="button" onClick={newSession}>
                    <Plus size={14} /> 对话任务
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTaskSurface('automations');
                      setLegacyView('tasks');
                    }}
                  >
                    <Plus size={14} /> 自动任务
                  </button>
                  <button
                    ref={taskListTriggerRef}
                    type="button"
                    aria-expanded={taskListOpen}
                    aria-controls="qoder-task-panel"
                    onClick={() => setTaskListOpen((open) => !open)}
                  >
                    <ClockCounterClockwise size={14} /> 任务列表
                  </button>
                </div>
              </header>
            )}
            <motion.div
              key={viewKey}
              className="view-body"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={MOTION_TRANSITION.routine}
            >
              <Suspense fallback={<ViewLoading />}>
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
                    startAtList={!showDetailNav && !boardWorkflowId}
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
                  loaded={settings.loaded}
                  error={settings.error}
                  preferences={uiPreferences}
                  onPreferenceChange={handlePreferenceChange}
                  onRetry={() => void settings.reload()}
                />
              ) : legacyView === 'usage' ? (
                <UsageView
                  usage={usage.data}
                  loading={usage.loading}
                  loaded={usage.loaded}
                  error={usage.error}
                  onRefresh={() => void usage.reload()}
                />
              ) : (
                <div className="chat-branch">
                  <AnimatePresence mode="wait" initial={false}>
                    {showWelcome && currentAgent ? (
                      <motion.div
                        key="welcome"
                        className="chat-content-branch"
                        exit={{ opacity: 0 }}
                        transition={MOTION_TRANSITION.exit}
                      >
                        <Welcome agent={currentAgent} onSuggestion={send} />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="thread"
                        className="chat-content-branch"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={MOTION_TRANSITION.routine}
                      >
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
                              : (trigger) => {
                                  outputsTriggerIdRef.current = trigger.id;
                                  setOutputsOpen(true);
                                }
                          }
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <motion.div
                    className={`composer-wrap${showWelcome ? ' welcome-composer' : ''}`}
                    layout
                    transition={{ layout: MOTION_LAYOUT_TRANSITION }}
                  >
                    <div className="composer-inner">
                      {chat.liveTurn && <TurnProgress turn={chat.liveTurn} />}
                      {chat.liveTurn && <StopTurnButton running onStop={chat.interrupt} />}
                      <label
                        className="qoder-composer-project"
                        aria-busy={projectContextBusy}
                        title={projectContextError || projectContextLabel}
                      >
                        <motion.span
                          key={projectContextLabel}
                          role={projectContextError ? 'alert' : 'status'}
                          initial={{ opacity: 0, y: 2 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={MOTION_TRANSITION.feedback}
                        >
                          {projectContextLabel}
                        </motion.span>
                        <select
                          aria-label={showWelcome ? '新会话项目' : '对话项目'}
                          value={selectedProjectId}
                          disabled={Boolean(chat.liveTurn) || projectsLoading}
                          onChange={(event) => {
                            sessionContextGenerationRef.current += 1;
                            setSessionContextLoading(false);
                            setProjectContextError('');
                            setSelectedProjectId(event.target.value);
                          }}
                        >
                          <option value="">当前仓库根（由服务端控制）</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Composer
                        resetSignal={composerResetSignal}
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
                </div>
                )}
              </Suspense>
            </motion.div>
          </motion.main>

          <>
            {taskListOpen && chatVisible && currentAgent && (
              <QoderTaskPanel
                key="chat-task-panel"
                sessions={sessions}
                currentSessionId={chat.currentSessionId}
                onOpenSession={(sessionId) => {
                  selectSession(sessionId);
                  setTaskListOpen(false);
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLTextAreaElement>('[aria-label="消息输入框"]')
                      ?.focus(),
                  );
                }}
                onOpenAutomations={() => {
                  setTaskListOpen(false);
                  setTaskSurface('automations');
                  setLegacyView('tasks');
                }}
                onClose={() => {
                  setTaskListOpen(false);
                  taskListTriggerRef.current?.focus();
                }}
              />
            )}
          </>

          <AnimatePresence initial={false}>
            {outputsOpen && currentAgentId && chat.currentSessionId && (
              <SessionOutputsPanel
                key="session-outputs-panel"
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
                returnFocusId={outputsTriggerIdRef.current}
                notify={notify}
              />
            )}
          </AnimatePresence>

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

          <Toasts toasts={toasts} onDismiss={dismissToast} />
        </div>
      </MotionConfig>
    </WorkspaceProvider>
  );
}
