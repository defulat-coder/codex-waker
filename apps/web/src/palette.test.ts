import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSummary, SessionSummary } from '@waker/contracts';
import { buildPaletteItems, filterPaletteItems } from './lib/palette.js';

function agent(id: string, name = id): AgentSummary {
  return {
    id,
    name,
    mark: name.slice(0, 2),
    tagline: `${name} 简介`,
    description: '',
    suggestions: [],
  };
}

function session(id: string, agentId: string, title = id): SessionSummary {
  return {
    id,
    agentId,
    title,
    createdAt: '2026-08-21T10:00:00+08:00',
    updatedAt: '2026-08-21T10:00:00+08:00',
    questionCount: 1,
    needsAttention: false,
  };
}

describe('buildPaletteItems', () => {
  it('包含 7 个页面项 + Agent 项 + 会话项', () => {
    const items = buildPaletteItems({
      agents: [agent('pi-assistant', '助手'), agent('researcher', '研究员')],
      sessionsByAgent: {
        'pi-assistant': [session('s1', 'pi-assistant', '聊天气泡')],
        researcher: [session('s2', 'researcher', '调研'), session('s3', 'researcher', '复盘')],
      },
    });
    assert.equal(items.length, 7 + 2 + 3);
    assert.deepEqual(
      items.slice(0, 7).map((item) => item.id),
      [
        'page:chat',
        'page:inbox',
        'page:agents',
        'page:templates',
        'page:skills',
        'page:usage',
        'page:settings',
      ],
    );
    const sessionItem = items.find((item) => item.id === 'session:s3');
    assert.equal(sessionItem?.group, 'sessions');
    assert.equal(sessionItem?.hint, '研究员');
    assert.deepEqual(sessionItem?.action, {
      kind: 'session',
      agentId: 'researcher',
      sessionId: 's3',
    });
  });

  it('Agent 项带 tagline 提示，动作指向该 Agent', () => {
    const items = buildPaletteItems({
      agents: [agent('pi-assistant', '助手')],
      sessionsByAgent: {},
    });
    const agentItem = items.find((item) => item.id === 'agent:pi-assistant');
    assert.equal(agentItem?.hint, '助手 简介');
    assert.deepEqual(agentItem?.action, { kind: 'agent', agentId: 'pi-assistant' });
  });
});

describe('filterPaletteItems', () => {
  const items = buildPaletteItems({
    agents: [agent('pi-assistant', '助手')],
    sessionsByAgent: { 'pi-assistant': [session('s1', 'pi-assistant', 'Weekly Report')] },
  });

  it('空查询返回全部', () => {
    assert.equal(filterPaletteItems(items, '').length, items.length);
    assert.equal(filterPaletteItems(items, '   ').length, items.length);
  });

  it('大小写不敏感，命中 label 或 hint', () => {
    assert.deepEqual(
      filterPaletteItems(items, 'weekly').map((item) => item.id),
      ['session:s1'],
    );
    assert.deepEqual(
      filterPaletteItems(items, '简介').map((item) => item.id),
      ['agent:pi-assistant'],
    );
    assert.equal(filterPaletteItems(items, '不存在').length, 0);
  });
});
