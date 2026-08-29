import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './store.js';
import {
  DEFAULT_MEMORY_STALE_AFTER_DAYS,
  MEMORY_MAINTENANCE_SNAPSHOT_OPERATION,
  runMemoryMaintenance,
} from './maintenance.js';

const scope = { type: 'waker' as const, id: 'waker-1' };

function makeStore(now: () => Date): MemoryStore {
  return new MemoryStore(':memory:', { now: () => now() });
}

describe('memory maintenance', () => {
  it('compacts duplicate titles: keeps the newest, snapshots and soft-deletes the rest', () => {
    let current = new Date('2024-06-01T00:00:00.000Z');
    const store = makeStore(() => current);
    try {
      const older = store.create({
        scope,
        source: 'conversation',
        title: '偏好',
        content: '# 偏好\n\n喜欢简洁回复。',
      });
      current = new Date('2024-06-02T00:00:00.000Z');
      const newer = store.create({
        scope,
        source: 'manual',
        title: ' 偏好 ',
        content: '# 偏好\n\n喜欢简洁回复，附带例子。',
      });
      const report = runMemoryMaintenance(store, { scope, trigger: 'cron', now: () => current });
      assert.equal(report.checked, 2);
      assert.equal(report.deleted, 1);
      assert.equal(report.skipped, 1);
      assert.equal(report.snapshotted, 1);
      assert.equal(report.trigger, 'cron');
      const deleted = report.actions.find((entry) => entry.action === 'deleted')!;
      assert.equal(deleted.documentId, older.id);
      assert.ok(deleted.snapshotId);
      assert.ok(deleted.reason.includes(newer.id));
      // 保留最新文档；被压实的文档从列表消失但版本历史保留，可用检查点快照回滚。
      assert.deepEqual(
        store.list({ scope }).map((document) => document.id),
        [newer.id],
      );
      assert.equal(store.listVersions(older.id).length, 2); // create + delete
      assert.equal(
        store.listSnapshots(older.id).at(-1)?.operation,
        MEMORY_MAINTENANCE_SNAPSHOT_OPERATION,
      );
      const restored = store.rollback(deleted.snapshotId!, {
        expectedVersion: store.listVersions(older.id).at(-1)!.version,
        apply: true,
      });
      assert.equal(restored.applied, true);
      assert.equal(store.get(older.id, scope).content, older.content);
    } finally {
      store.close();
    }
  });

  it('archives stale memories that were never revised, keeps fresh ones', () => {
    let current = new Date('2024-01-01T00:00:00.000Z');
    const store = makeStore(() => current);
    try {
      const stale = store.create({
        scope,
        source: 'conversation',
        title: '旧事实',
        content: '# 旧事实\n\n很久以前记住的事情。',
      });
      // 老文档被修订过一次：updatedAt !== createdAt，不算「从未被触达」，不归档。
      const revised = store.create({
        scope,
        source: 'manual',
        title: '老但常改',
        content: '# 老但常改\n\nv1',
      });
      current = new Date('2024-01-02T00:00:00.000Z');
      store.update(revised.id, { expectedVersion: 1, content: '# 老但常改\n\nv2' });
      current = new Date('2024-06-01T00:00:00.000Z');
      const fresh = store.create({
        scope,
        source: 'manual',
        title: '新事实',
        content: '# 新事实\n\n刚记住的事情。',
      });
      const report = runMemoryMaintenance(store, { scope, now: () => current });
      assert.equal(report.checked, 3);
      assert.equal(report.deleted, 1);
      assert.equal(report.skipped, 2);
      assert.equal(report.trigger, 'manual');
      const deletedIds = report.actions
        .filter((entry) => entry.action === 'deleted')
        .map((entry) => entry.documentId);
      assert.deepEqual(deletedIds, [stale.id]);
      assert.deepEqual(
        store.list({ scope }).map((document) => document.id).sort(),
        [fresh.id, revised.id].sort(),
      );
    } finally {
      store.close();
    }
  });

  it('respects a custom staleAfterDays and validates it', () => {
    let current = new Date('2024-06-01T00:00:00.000Z');
    const store = makeStore(() => current);
    try {
      store.create({ scope, source: 'manual', title: '三天前', content: '# 三天前\n\nx' });
      current = new Date('2024-06-04T00:00:00.000Z');
      const report = runMemoryMaintenance(store, { scope, staleAfterDays: 2 });
      assert.equal(report.deleted, 1);
      assert.throws(
        () => runMemoryMaintenance(store, { scope, staleAfterDays: 0 }),
        /staleAfterDays/,
      );
      assert.ok(DEFAULT_MEMORY_STALE_AFTER_DAYS >= 30);
    } finally {
      store.close();
    }
  });

  it('does not touch other scopes and reports an empty run cleanly', () => {
    const current = new Date('2024-06-01T00:00:00.000Z');
    const store = makeStore(() => current);
    try {
      store.create({
        scope: { type: 'project', id: 'p1' },
        source: 'manual',
        title: '项目记忆',
        content: '# 项目记忆\n\nx',
      });
      const report = runMemoryMaintenance(store, { scope });
      assert.equal(report.checked, 0);
      assert.equal(report.deleted, 0);
      assert.equal(report.skipped, 0);
      assert.deepEqual(report.actions, []);
      assert.equal(store.list({ scope: { type: 'project', id: 'p1' } }).length, 1);
    } finally {
      store.close();
    }
  });
});
