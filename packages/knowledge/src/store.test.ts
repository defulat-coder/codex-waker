import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { EmbeddingAdapter } from './embedding.js';
import { KnowledgeError, KnowledgeStore } from './store.js';

function fixture(options: ConstructorParameters<typeof KnowledgeStore>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'waker-knowledge-'));
  const file = join(directory, 'knowledge.sqlite');
  const store = new KnowledgeStore(file, { chunkSize: 28, ...options });
  return {
    file,
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('migrations are versioned and idempotent', () => {
  const item = fixture();
  assert.deepEqual(item.store.migrationVersions(), [1]);
  item.store.close();
  const reopened = new KnowledgeStore(item.file);
  assert.deepEqual(reopened.migrationVersions(), [1]);
  assert.equal(reopened.countRows('documents'), 0);
  reopened.close();
  rmSync(dirname(item.file), { recursive: true, force: true });
});

test('document CRUD keeps versions and rejects stale writes', async () => {
  const item = fixture();
  try {
    const notebook = item.store.createNotebook({ id: 'notes', name: 'Notes' });
    assert.equal(
      item.store.updateNotebook('notes', { description: 'Reference notes' }).description,
      'Reference notes',
    );
    const created = await item.store.createDocument({
      id: 'guide',
      notebookId: notebook.id,
      title: 'Local guide',
      sourceUri: 'file:///guide.md',
      content: 'alpha first line\nbeta second line\ngamma third line',
      metadata: { kind: 'guide' },
    });
    assert.equal(created.currentVersion, 1);
    assert.equal(created.metadata.kind, 'guide');

    const updated = await item.store.updateDocument('guide', {
      expectedVersion: 1,
      content: 'delta replacement\nepsilon detail',
      title: 'Updated guide',
    });
    assert.equal(updated.currentVersion, 2);
    assert.equal(updated.title, 'Updated guide');
    assert.equal(item.store.countRows('document_versions'), 2);
    assert.equal(item.store.listDocuments('notes')[0]?.id, 'guide');
    assert.match(item.store.getDocumentVersion('guide', 1).content, /alpha/);
    await assert.rejects(
      item.store.updateDocument('guide', { expectedVersion: 1, content: 'stale' }),
      (error: unknown) => error instanceof KnowledgeError && error.code === 'VERSION_CONFLICT',
    );
  } finally {
    item.cleanup();
  }
});

test('notebook deletion cascades all search state', async () => {
  const item = fixture();
  try {
    item.store.createNotebook({ id: 'temporary', name: 'Temporary' });
    await item.store.createDocument({
      notebookId: 'temporary',
      title: 'Temporary',
      content: 'delete this indexed text',
    });
    assert.equal(item.store.deleteNotebook('temporary'), true);
    assert.equal(item.store.countRows('documents'), 0);
    assert.equal(item.store.countRows('chunks'), 0);
    assert.equal(item.store.countRows('chunks_fts'), 0);
    assert.equal(item.store.countRows('embeddings'), 0);
  } finally {
    item.cleanup();
  }
});

test('keyword, vector, and hybrid search return traceable current-version citations', async () => {
  const item = fixture();
  try {
    item.store.createNotebook({ id: 'kb', name: 'Knowledge' });
    await item.store.createDocument({
      id: 'one',
      notebookId: 'kb',
      title: 'Fruit handbook',
      sourceUri: 'file:///fruit.md',
      content: 'preface\napple orchard harvest\nclosing',
    });
    await item.store.createDocument({
      id: 'two',
      notebookId: 'kb',
      title: 'Vehicle handbook',
      content: 'preface\ndiesel engine maintenance\nclosing',
    });

    for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
      const results = await item.store.search('apple orchard', { mode, notebookId: 'kb' });
      assert.equal(results[0]?.documentId, 'one', mode);
      assert.equal(results[0]?.citation.sourceUri, 'file:///fruit.md');
      assert.equal(results[0]?.citation.version, 1);
      assert.ok((results[0]?.citation.startLine ?? 0) >= 1);
      assert.ok((results[0]?.citation.endLine ?? 0) >= (results[0]?.citation.startLine ?? 0));
    }

    await item.store.updateDocument('one', {
      expectedVersion: 1,
      content: 'pear orchard only',
    });
    assert.equal((await item.store.search('apple', { mode: 'keyword' })).length, 0);
    assert.equal((await item.store.search('pear', { mode: 'keyword' }))[0]?.version, 2);
  } finally {
    item.cleanup();
  }
});

test('bindings isolate reads and enforce read-only writes', async () => {
  const item = fixture();
  try {
    item.store.createNotebook({ id: 'private-a', name: 'A' });
    item.store.createNotebook({ id: 'private-b', name: 'B' });
    await item.store.createDocument({
      notebookId: 'private-a',
      title: 'A',
      content: 'shared secret alpha',
    });
    await item.store.createDocument({
      notebookId: 'private-b',
      title: 'B',
      content: 'shared secret beta',
    });
    const reader = { scopeType: 'waker', scopeId: 'reader' };
    item.store.bindNotebook('private-a', reader, false);

    assert.deepEqual(
      item.store
        .listBindings('private-a')
        .map(({ scopeType, scopeId, canWrite }) => ({ scopeType, scopeId, canWrite })),
      [{ scopeType: 'waker', scopeId: 'reader', canWrite: false }],
    );

    assert.deepEqual(
      item.store.listNotebooks(reader).map((entry) => entry.id),
      ['private-a'],
    );
    const results = await item.store.search('shared secret', { binding: reader, mode: 'keyword' });
    assert.ok(results.length > 0);
    assert.ok(results.every((result) => result.notebookId === 'private-a'));
    await assert.rejects(
      item.store.createDocument({
        notebookId: 'private-a',
        title: 'Denied',
        content: 'x',
        binding: reader,
      }),
      (error: unknown) => error instanceof KnowledgeError && error.code === 'READ_ONLY',
    );
    assert.throws(
      () =>
        item.store.getDocument(results[0]!.documentId, { scopeType: 'waker', scopeId: 'other' }),
      (error: unknown) => error instanceof KnowledgeError && error.code === 'FORBIDDEN',
    );
    assert.equal(item.store.unbindNotebook('private-a', reader), true);
    assert.equal(item.store.unbindNotebook('private-a', reader), false);
    assert.deepEqual(item.store.listNotebooks(reader), []);
    assert.ok(
      item.store
        .listAudits('private-a')
        .some((entry) => entry.action === 'binding.removed' && entry.details.scopeId === 'reader'),
    );
  } finally {
    item.cleanup();
  }
});

test('force rebuild is consistent and deletion cascades through FTS and embeddings', async () => {
  const item = fixture();
  try {
    item.store.createNotebook({ id: 'kb', name: 'KB' });
    await item.store.createDocument({
      id: 'doc',
      notebookId: 'kb',
      title: 'Doc',
      content: 'one long knowledge line\ntwo long knowledge line\nthree long knowledge line',
    });
    const chunks = item.store.countRows('chunks');
    assert.ok(chunks > 1);
    assert.equal(item.store.countRows('chunks_fts'), chunks);
    assert.equal(item.store.countRows('embeddings'), chunks);
    assert.equal(await item.store.rebuild(), 0);
    assert.equal(await item.store.rebuild({ documentId: 'doc', force: true }), 1);
    assert.equal(item.store.countRows('chunks'), chunks);
    assert.equal(item.store.countRows('chunks_fts'), chunks);
    assert.equal(item.store.countRows('embeddings'), chunks);

    assert.equal(item.store.deleteDocument('doc'), true);
    assert.equal(item.store.countRows('documents'), 0);
    assert.equal(item.store.countRows('document_versions'), 0);
    assert.equal(item.store.countRows('chunks'), 0);
    assert.equal(item.store.countRows('chunks_fts'), 0);
    assert.equal(item.store.countRows('embeddings'), 0);
  } finally {
    item.cleanup();
  }
});

test('embedding failure degrades hybrid and vector searches to keyword', async () => {
  const failing: EmbeddingAdapter = {
    model: 'fails',
    dimensions: 8,
    async embed() {
      throw new Error('offline');
    },
  };
  const item = fixture({ embedding: failing });
  try {
    item.store.createNotebook({ id: 'kb', name: 'KB' });
    await item.store.createDocument({
      notebookId: 'kb',
      title: 'Fallback',
      content: 'resilient keyword path',
    });
    assert.equal(item.store.countRows('embeddings'), 0);
    for (const mode of ['hybrid', 'vector'] as const) {
      const results = await item.store.search('resilient', { mode });
      assert.equal(results[0]?.title, 'Fallback');
      assert.ok(results[0]?.keywordScore !== undefined);
    }
  } finally {
    item.cleanup();
  }
});
