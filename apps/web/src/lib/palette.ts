import type { AgentSummary, SessionSummary } from '@waker/contracts';
import type { ExploreView } from './explore.js';
import type { SystemView } from './types.js';

/** 命令面板动作：页面导航 / 选择 Agent / 打开会话。 */
export type PaletteAction =
  | { kind: 'chat' }
  | { kind: 'inbox' }
  | { kind: 'explore'; view: ExploreView }
  | { kind: 'system'; view: SystemView }
  | { kind: 'agent'; agentId: string }
  | { kind: 'session'; agentId: string; sessionId: string };

export type PaletteGroup = 'pages' | 'agents' | 'sessions';

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  /** 右侧弱色提示（Agent tagline / 所属 Agent 名）。 */
  hint?: string;
  action: PaletteAction;
};

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  pages: '页面',
  agents: 'Agent',
  sessions: '会话',
};

export const PALETTE_GROUP_ORDER: PaletteGroup[] = ['pages', 'agents', 'sessions'];

const PAGE_ITEMS: PaletteItem[] = [
  { id: 'page:chat', group: 'pages', label: '会话', action: { kind: 'chat' } },
  { id: 'page:inbox', group: 'pages', label: '收件箱', action: { kind: 'inbox' } },
  {
    id: 'page:agents',
    group: 'pages',
    label: 'Agents',
    action: { kind: 'explore', view: 'agents' },
  },
  {
    id: 'page:templates',
    group: 'pages',
    label: '模板',
    action: { kind: 'explore', view: 'templates' },
  },
  { id: 'page:skills', group: 'pages', label: '技能', action: { kind: 'explore', view: 'skills' } },
  { id: 'page:usage', group: 'pages', label: '用量', action: { kind: 'system', view: 'usage' } },
  {
    id: 'page:settings',
    group: 'pages',
    label: '设置',
    action: { kind: 'system', view: 'settings' },
  },
];

export function buildPaletteItems(input: {
  agents: AgentSummary[];
  sessionsByAgent: Record<string, SessionSummary[]>;
}): PaletteItem[] {
  const agentName = new Map(input.agents.map((agent) => [agent.id, agent.name]));
  const agentItems: PaletteItem[] = input.agents.map((agent) => ({
    id: `agent:${agent.id}`,
    group: 'agents',
    label: agent.name,
    hint: agent.tagline,
    action: { kind: 'agent', agentId: agent.id },
  }));
  const sessionItems: PaletteItem[] = Object.entries(input.sessionsByAgent).flatMap(
    ([agentId, sessions]) =>
      sessions.map((session) => ({
        id: `session:${session.id}`,
        group: 'sessions' as const,
        label: session.title,
        hint: agentName.get(agentId),
        action: { kind: 'session' as const, agentId, sessionId: session.id },
      })),
  );
  return [...PAGE_ITEMS, ...agentItems, ...sessionItems];
}

/** 大小写不敏感的子串过滤，命中 label 或 hint；空查询返回全部。 */
export function filterPaletteItems(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.label.toLowerCase().includes(q) || item.hint?.toLowerCase().includes(q),
  );
}
