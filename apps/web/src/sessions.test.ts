import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionSummary } from '@waker/contracts';
import {
  filterAttention,
  formatRelativeTime,
  groupSessions,
  sortSessions,
} from './lib/sessions.js';

function session(id: string, updatedAt: string, title = id): SessionSummary {
  return {
    id,
    agentId: 'pi-assistant',
    title,
    createdAt: updatedAt,
    updatedAt,
    questionCount: 1,
    needsAttention: false,
  };
}

const NOW = new Date('2026-08-21T15:00:00+08:00');

describe('groupSessions', () => {
  it('按 今天/昨天/本周/更早 分组并按更新时间倒序', () => {
    const items = [
      session('old', '2026-07-01T10:00:00+08:00'),
      session('today-a', '2026-08-21T09:00:00+08:00'),
      session('week', '2026-08-18T10:00:00+08:00'),
      session('today-b', '2026-08-21T14:00:00+08:00'),
      session('yesterday', '2026-08-20T23:00:00+08:00'),
    ];
    const groups = groupSessions(items, NOW);
    assert.deepEqual(
      groups.map((group) => group.label),
      ['今天', '昨天', '本周', '更早'],
    );
    assert.deepEqual(
      groups[0]!.items.map((item) => item.id),
      ['today-b', 'today-a'],
    );
    assert.deepEqual(
      groups[1]!.items.map((item) => item.id),
      ['yesterday'],
    );
    assert.deepEqual(
      groups[2]!.items.map((item) => item.id),
      ['week'],
    );
    assert.deepEqual(
      groups[3]!.items.map((item) => item.id),
      ['old'],
    );
  });

  it('空分组被省略，非法时间归入更早', () => {
    const groups = groupSessions([session('broken', 'not-a-date')], NOW);
    assert.deepEqual(
      groups.map((group) => group.key),
      ['earlier'],
    );
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(groupSessions([], NOW), []);
  });
});

describe('sortSessions', () => {
  it('按 updatedAt 倒序且不改动原数组', () => {
    const items = [
      session('a', '2026-08-20T10:00:00+08:00'),
      session('b', '2026-08-21T10:00:00+08:00'),
    ];
    const sorted = sortSessions(items);
    assert.deepEqual(
      sorted.map((item) => item.id),
      ['b', 'a'],
    );
    assert.deepEqual(
      items.map((item) => item.id),
      ['a', 'b'],
    );
  });
});

describe('filterAttention', () => {
  it('只保留 needsAttention 的会话', () => {
    const items = [
      session('ok', '2026-08-21T10:00:00+08:00'),
      {
        ...session('bad', '2026-08-21T11:00:00+08:00'),
        needsAttention: true,
        attentionReason: 'error' as const,
      },
    ];
    assert.deepEqual(
      filterAttention(items).map((item) => item.id),
      ['bad'],
    );
  });
});

describe('formatRelativeTime', () => {
  it('按距今时长给出 刚刚/分钟/小时/昨天/日期', () => {
    assert.equal(formatRelativeTime('2026-08-21T14:59:30+08:00', NOW), '刚刚');
    assert.equal(formatRelativeTime('2026-08-21T14:40:00+08:00', NOW), '20 分钟前');
    assert.equal(formatRelativeTime('2026-08-21T09:00:00+08:00', NOW), '6 小时前');
    assert.equal(formatRelativeTime('2026-08-20T23:00:00+08:00', NOW), '昨天');
    assert.equal(formatRelativeTime('2026-08-18T10:00:00+08:00', NOW), '8月18日');
    assert.equal(formatRelativeTime('not-a-date', NOW), '');
  });
});
