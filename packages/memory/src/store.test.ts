import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { MemoryError, MemoryStore } from './store.js';

function fixture(now: () => Date = () => new Date()) {
  const directory = mkdtempSync(join(tmpdir(), 'waker-memory-'));
  const file = join(directory, 'memory.sqlite');
  const store = new MemoryStore(file, { now });
  return {
    file,
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const waker = { type: 'waker', id: 'waker-1' } as const;
const project = { type: 'project', id: 'project-1' } as const;

test('migration is versioned and idempotent', () => {
  const item = fixture();
  assert.deepEqual(item.store.migrationVersions(), [1]);
  item.store.close();
  const reopened = new MemoryStore(item.file);
  assert.deepEqual(reopened.migrationVersions(), [1]);
  reopened.close();
  rmSync(dirname(item.file), { recursive: true, force: true });
});

test('CRUD canonicalizes Markdown, isolates scopes, and rejects stale writes', () => {
  const item = fixture();
  try {
    const created = item.store.create({
      id: 'preferences',
      scope: waker,
      source: 'user',
      title: 'Preferences',
      content: '  likes tea  \r\n\r\n',
    });
    item.store.create({
      id: 'project-notes',
      scope: project,
      source: 'session',
      title: 'Notes',
      content: '# Project\nUse pnpm',
    });
    assert.equal(created.content, 'likes tea\n');
    assert.deepEqual(
      item.store.list({ scope: waker }).map(({ id }) => id),
      ['preferences'],
    );
    assert.throws(
      () => item.store.get('preferences', project),
      (error: unknown) => error instanceof MemoryError && error.code === 'SCOPE_MISMATCH',
    );

    const updated = item.store.update('preferences', {
      expectedVersion: 1,
      scope: waker,
      content: 'likes green tea',
    });
    assert.equal(updated.version, 2);
    assert.equal(item.store.listVersions('preferences').length, 2);
    assert.throws(
      () => item.store.update('preferences', { expectedVersion: 1, content: 'stale' }),
      (error: unknown) => error instanceof MemoryError && error.code === 'VERSION_CONFLICT',
    );
    assert.equal(item.store.delete('preferences', { expectedVersion: 2, scope: waker }), true);
    assert.throws(
      () => item.store.get('preferences'),
      (error: unknown) => error instanceof MemoryError && error.code === 'NOT_FOUND',
    );
  } finally {
    item.cleanup();
  }
});

test('timeline supports scope, source, action, and time filters', () => {
  let tick = 0;
  const item = fixture(() => new Date(`2026-01-01T00:00:0${tick++}.000Z`));
  try {
    item.store.create({ id: 'a', scope: waker, source: 'user', title: 'A', content: 'one' });
    item.store.update('a', { expectedVersion: 1, content: 'two' });
    item.store.create({ id: 'b', scope: project, source: 'session', title: 'B', content: 'three' });
    assert.deepEqual(
      item.store
        .listAudits({ scope: waker, source: 'user', action: 'update' })
        .map(({ action }) => action),
      ['update'],
    );
    assert.equal(item.store.listTimeline({ from: '2026-01-01T00:00:03.000Z' }).length, 1);
  } finally {
    item.cleanup();
  }
});

test('snapshot, readable diff, dry-run, and rollback preserve a pre-rollback snapshot', () => {
  const item = fixture();
  try {
    item.store.create({
      id: 'doc',
      scope: waker,
      source: 'user',
      title: 'Doc',
      content: 'alpha\nbeta',
    });
    const first = item.store.snapshot('doc');
    item.store.update('doc', { expectedVersion: 1, content: 'alpha\ngamma' });
    const second = item.store.snapshot('doc');
    assert.match(item.store.diff(first.id, second.id), /-beta\n\+gamma/);

    const dryRun = item.store.rollback(first.id, { expectedVersion: 2 });
    assert.equal(dryRun.applied, false);
    assert.equal(item.store.get('doc').content, 'alpha\ngamma\n');

    const result = item.store.rollback(first.id, { expectedVersion: 2, apply: true });
    assert.equal(result.applied, true);
    assert.equal(result.document.version, 3);
    assert.equal(result.document.content, 'alpha\nbeta\n');
    assert.equal(result.preRollbackSnapshot?.operation, 'pre_rollback');
    assert.equal(item.store.listSnapshots('doc').length, 3);
    assert.equal(item.store.listVersions('doc').at(-1)?.operation, 'rollback');
  } finally {
    item.cleanup();
  }
});

test('JSON and Markdown import/export round-trip without partial conflict writes', () => {
  const source = fixture();
  const target = fixture();
  try {
    source.store.create({
      id: 'json',
      scope: waker,
      source: 'user',
      title: 'JSON',
      content: '# JSON\nbody',
    });
    const imported = target.store.importJson(source.store.exportJson({ scope: waker }));
    assert.equal(imported[0]?.content, '# JSON\nbody\n');
    assert.throws(
      () => target.store.importJson(source.store.exportJson()),
      (error: unknown) => error instanceof MemoryError && error.code === 'IMPORT_CONFLICT',
    );
    assert.equal(target.store.list().length, 1);

    const markdown = source.store.exportMarkdown('json', waker);
    const markdownDocument = target.store.importMarkdown({
      id: 'markdown',
      scope: { type: 'group', id: 'group-1' },
      source: 'import',
      title: 'Markdown',
      markdown,
    });
    assert.equal(markdownDocument.content, markdown);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});
