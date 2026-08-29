import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore } from './session-store.js';
import {
  emptySidebarSections,
  SidebarSectionsValidationError,
  validateSidebarSections,
} from './sidebar-sections.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; store: AgentSessionStore } {
  const root = mkdtempSync(join(tmpdir(), 'codex-sidebar-sections-'));
  roots.push(root);
  return { root, store: new AgentSessionStore({ cwd: root }) };
}

describe('validateSidebarSections', () => {
  it('rejects non-object payloads', () => {
    for (const value of [null, undefined, 42, 'x', []]) {
      assert.throws(() => validateSidebarSections(value), SidebarSectionsValidationError);
    }
  });

  it('rejects duplicate ids, bad names and illegal nesting', () => {
    const section = (id: string, parentId: string | null = null, name = id) => ({
      id,
      name,
      parentId,
      order: 0,
    });
    assert.throws(
      () => validateSidebarSections({ sections: [section('a'), section('a')] }),
      /duplicate section id/,
    );
    assert.throws(
      () => validateSidebarSections({ sections: [section('a', null, '')] }),
      /1-32 characters/,
    );
    assert.throws(
      () => validateSidebarSections({ sections: [section('a', null, 'x'.repeat(33))] }),
      /1-32 characters/,
    );
    assert.throws(
      () => validateSidebarSections({ sections: [section('a', 'missing')] }),
      /parent not found/,
    );
    // 自父级在旧版实现里先命中「最多两级」分支（parent 即自身且 parentId 非空），保持一致。
    assert.throws(
      () => validateSidebarSections({ sections: [section('a', 'a')] }),
      /at most two levels/,
    );
    assert.throws(
      () =>
        validateSidebarSections({
          sections: [section('a'), section('b', 'a'), section('c', 'b')],
        }),
      /at most two levels/,
    );
  });

  it('drops references to unknown sections and dedupes entryOrder', () => {
    const state = validateSidebarSections({
      sections: [{ id: 'a', name: 'A', parentId: null, order: 2 }],
      assignments: { 'session-1': 'a', 'session-2': 'ghost' },
      collapsed: ['a', 'ghost'],
      entryOrder: ['a', 'session-1', 'a', ' ', 'session-1'],
    });
    assert.deepEqual(state.assignments, { 'session-1': 'a' });
    assert.deepEqual(state.collapsed, ['a']);
    assert.deepEqual(state.entryOrder, ['a', 'session-1']);
    assert.ok(state.updatedAt);
  });

  it('fills defaults for missing fields', () => {
    const state = validateSidebarSections({});
    assert.deepEqual(state.sections, []);
    assert.deepEqual(state.assignments, {});
    assert.deepEqual(state.entryOrder, []);
    assert.deepEqual(state.collapsed, []);
  });
});

describe('sidebar sections store', () => {
  it('returns the empty default before the first write', async () => {
    const { store } = fixture();
    const state = await store.getSidebarSections('codex-assistant');
    assert.deepEqual({ ...state, updatedAt: '' }, { ...emptySidebarSections(), updatedAt: '' });
  });

  it('round-trips a full replace and preserves order/collapsed', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'session-a');
    await store.createSession('codex-assistant', 'session-b');
    const saved = await store.putSidebarSections('codex-assistant', {
      sections: [
        { id: 'work', name: '工作', parentId: null, order: 1 },
        { id: 'work-sub', name: '子分组', parentId: 'work', order: 0 },
      ],
      assignments: { 'session-a': 'work-sub' },
      entryOrder: ['work', 'session-b'],
      collapsed: ['work'],
    });
    assert.deepEqual(saved.sections, [
      { id: 'work', name: '工作', parentId: null, order: 1 },
      { id: 'work-sub', name: '子分组', parentId: 'work', order: 0 },
    ]);
    assert.deepEqual(saved.assignments, { 'session-a': 'work-sub' });
    assert.deepEqual(saved.entryOrder, ['work', 'session-b']);
    assert.deepEqual(saved.collapsed, ['work']);

    const reread = await store.getSidebarSections('codex-assistant');
    assert.deepEqual(reread, saved);
    // 其他 Agent 的分组互不可见。
    const other = await store.getSidebarSections('other-agent');
    assert.deepEqual(other.sections, []);
  });

  it('rejects session ids that are unknown or bound to another agent', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'session-a');
    await store.createSession('other-agent', 'session-foreign');
    const payload = {
      sections: [{ id: 's', name: 'S', parentId: null, order: 0 }],
      assignments: { 'session-foreign': 's' },
    };
    await assert.rejects(
      () => store.putSidebarSections('codex-assistant', payload),
      SidebarSectionsValidationError,
    );
    await assert.rejects(
      () =>
        store.putSidebarSections('codex-assistant', {
          sections: [{ id: 's', name: 'S', parentId: null, order: 0 }],
          assignments: { 'session-ghost': 's' },
        }),
      SidebarSectionsValidationError,
    );
    // entryOrder 里非 section id 的条目同样按 sessionId 校验。
    await assert.rejects(
      () =>
        store.putSidebarSections('codex-assistant', {
          sections: [{ id: 's', name: 'S', parentId: null, order: 0 }],
          entryOrder: ['s', 'session-ghost'],
        }),
      SidebarSectionsValidationError,
    );
  });

  it('prunes references when a session is deleted', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'session-a');
    await store.createSession('codex-assistant', 'session-b');
    await store.putSidebarSections('codex-assistant', {
      sections: [{ id: 's', name: 'S', parentId: null, order: 0 }],
      assignments: { 'session-a': 's' },
      entryOrder: ['s', 'session-b'],
      collapsed: [],
    });
    await store.deleteSession('session-a', 'codex-assistant');
    const state = await store.getSidebarSections('codex-assistant');
    assert.deepEqual(state.assignments, {});
    assert.deepEqual(state.entryOrder, ['s', 'session-b']);
    // 分组定义本身保留，回读可直接再次 PUT 而不触发 sessionId 校验失败。
    await store.putSidebarSections('codex-assistant', state);
  });

  it('deletes the per-agent row on agent removal', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'session-a');
    await store.putSidebarSections('codex-assistant', {
      sections: [{ id: 's', name: 'S', parentId: null, order: 0 }],
      assignments: { 'session-a': 's' },
      entryOrder: ['s'],
      collapsed: ['s'],
    });
    store.deleteSidebarSections('codex-assistant');
    const state = await store.getSidebarSections('codex-assistant');
    assert.deepEqual(state.sections, []);
    assert.deepEqual(state.assignments, {});
  });
});
