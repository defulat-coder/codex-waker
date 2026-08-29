import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { CaretLeft } from '@phosphor-icons/react/dist/icons/CaretLeft';
import { House } from '@phosphor-icons/react/dist/icons/House';
import { Globe } from '@phosphor-icons/react/dist/icons/Globe';
import { Lightning } from '@phosphor-icons/react/dist/icons/Lightning';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { FlowArrow } from '@phosphor-icons/react/dist/icons/FlowArrow';
import { Brain } from '@phosphor-icons/react/dist/icons/Brain';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { BookOpenText } from '@phosphor-icons/react/dist/icons/BookOpenText';
import { Plugs } from '@phosphor-icons/react/dist/icons/Plugs';
import { ChatsCircle } from '@phosphor-icons/react/dist/icons/ChatsCircle';
import { ShieldCheck } from '@phosphor-icons/react/dist/icons/ShieldCheck';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { cx } from '../lib/cx.js';
import { MOTION_TRANSITION } from '../lib/motion.js';

/** Waker 详情二级导航键，与 legacyView/面板状态的映射由 App 负责。 */
export type WakerDetailNavKey =
  | 'home'
  | 'projects'
  | 'automations'
  | 'chat-tasks'
  | 'workflows'
  | 'memory'
  | 'skills'
  | 'knowledge'
  | 'connectors'
  | 'im'
  | 'permissions'
  | 'settings';

interface NavItem {
  key: WakerDetailNavKey;
  label: string;
  icon: ReactNode;
}

/** 条目顺序对齐 QoderWake 0.4.2 实测：设置经分隔线沉底。 */
const ITEMS: NavItem[] = [
  { key: 'home', label: '首页', icon: <House size={18} /> },
  { key: 'projects', label: '项目', icon: <Globe size={18} /> },
  { key: 'automations', label: '自动任务', icon: <Lightning size={18} /> },
  { key: 'chat-tasks', label: '对话任务', icon: <ChatCircle size={18} /> },
  { key: 'workflows', label: '工作流', icon: <FlowArrow size={18} /> },
  { key: 'memory', label: '记忆', icon: <Brain size={18} /> },
  { key: 'skills', label: '技能', icon: <PuzzlePiece size={18} /> },
  { key: 'knowledge', label: '知识库', icon: <BookOpenText size={18} /> },
  { key: 'connectors', label: '连接器', icon: <Plugs size={18} /> },
  { key: 'im', label: 'IM', icon: <ChatsCircle size={18} /> },
  { key: 'permissions', label: '权限', icon: <ShieldCheck size={18} /> },
];

const SETTINGS_ITEM: NavItem = { key: 'settings', label: '设置', icon: <GearSix size={18} /> };

/**
 * Waker 详情导航（QoderWake 0.4.2 二级导航）：浏览某个 Waker 的页面时
 * 显示在主导航与内容区之间。返回按钮回「我的 Waker」，条目由 App 统一
 * 绑定 Agent 上下文后切换目标视图；active 由 App 按当前视图推导。
 */
export function WakerDetailNav({
  agentName,
  active,
  onBack,
  onNavigate,
}: {
  agentName: string;
  active: WakerDetailNavKey | null;
  onBack: () => void;
  onNavigate: (key: WakerDetailNavKey) => void;
}) {
  const renderItem = (item: NavItem) => (
    <motion.button
      type="button"
      key={item.key}
      className={cx('waker-detail-nav-item', active === item.key && 'active')}
      aria-current={active === item.key ? 'page' : undefined}
      whileTap={{ scale: 0.97 }}
      onClick={() => onNavigate(item.key)}
    >
      {item.icon}
      <span>{item.label}</span>
    </motion.button>
  );

  return (
    <motion.nav
      className="waker-detail-nav"
      aria-label="Waker 详情导航"
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={MOTION_TRANSITION.panel}
    >
      <button type="button" className="waker-detail-nav-back" onClick={onBack}>
        <CaretLeft size={14} aria-hidden="true" />
        我的 Waker
      </button>
      <p className="waker-detail-nav-agent" title={agentName}>
        {agentName}
      </p>
      <div className="waker-detail-nav-items">
        {ITEMS.map(renderItem)}
        <div className="waker-detail-nav-splitter" role="separator" />
        {renderItem(SETTINGS_ITEM)}
      </div>
    </motion.nav>
  );
}
