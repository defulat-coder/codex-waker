import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ArtifactStore, ArtifactStoreError } from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(maxAttachmentBytes = 1024): { root: string; store: ArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), 'waker-artifacts-'));
  roots.push(root);
  return {
    root,
    store: new ArtifactStore({ storageRoot: root, maxAttachmentBytes }),
  };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ArtifactStoreError && error.code === code;
}

describe('ArtifactStore migrations', () => {
  it('applies versioned migrations once and reopens existing data', () => {
    const { root, store } = fixture();
    assert.deepEqual(store.migrationVersions(), ['001']);
    store.importBuffer({
      sessionId: 'session-1',
      originalName: 'note.txt',
      mimeType: 'text/plain',
      data: Buffer.from('hello'),
    });
    store.close();

    const reopened = new ArtifactStore({ storageRoot: root });
    assert.deepEqual(reopened.migrationVersions(), ['001']);
    assert.equal(reopened.listAttachments('session-1').length, 1);
    reopened.close();
  });
});

describe('attachments', () => {
  it('imports and reads text, binary, and an in-root path with download metadata', () => {
    const { root, store } = fixture();
    try {
      const text = store.importBuffer({
        sessionId: 'session-1',
        originalName: 'note.txt',
        mimeType: 'text/plain',
        data: Buffer.from('你好'),
      });
      assert.equal(store.readAttachment('session-1', text.id).toString(), '你好');
      assert.equal(text.status, 'ready');

      const binaryData = Buffer.from([0, 255, 1, 2, 128]);
      const binary = store.importBuffer({
        sessionId: 'session-1',
        originalName: 'image.bin',
        mimeType: 'application/octet-stream',
        data: binaryData,
      });
      assert.deepEqual(store.readAttachment('session-1', binary.id), binaryData);
      const download = store.downloadMetadata('session-1', binary.id);
      assert.equal(download.originalName, 'image.bin');
      assert.equal(download.size, binaryData.length);
      assert.ok(relative(store.storageRoot, download.absolutePath).startsWith('blobs'));

      mkdirSync(join(root, 'incoming'));
      writeFileSync(join(root, 'incoming', 'from-path.txt'), 'path payload');
      const fromPath = store.importPath({
        sessionId: 'session-1',
        sourcePath: 'incoming/from-path.txt',
        mimeType: 'text/plain',
      });
      assert.equal(store.readAttachment('session-1', fromPath.id).toString(), 'path payload');
      assert.equal(store.listAttachments('session-1').length, 3);
    } finally {
      store.close();
    }
  });

  it('rejects traversal, absolute paths, symlinks, and secret-like filenames', () => {
    const { root, store } = fixture();
    const outside = join(dirname(root), `${root.split('/').at(-1)}-outside.txt`);
    roots.push(outside);
    writeFileSync(outside, 'outside');
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'waker-artifacts-outside-'));
    roots.push(outsideDirectory);
    mkdirSync(join(root, 'incoming'));
    symlinkSync(outside, join(root, 'incoming', 'link.txt'));
    symlinkSync(outsideDirectory, join(root, 'escaped'));
    try {
      assert.throws(
        () =>
          store.importPath({
            sessionId: 's',
            sourcePath: '../outside.txt',
            mimeType: 'text/plain',
          }),
        hasCode('UNSAFE_PATH'),
      );
      assert.throws(
        () => store.importPath({ sessionId: 's', sourcePath: outside, mimeType: 'text/plain' }),
        hasCode('UNSAFE_PATH'),
      );
      assert.throws(
        () =>
          store.importPath({
            sessionId: 's',
            sourcePath: 'incoming/link.txt',
            mimeType: 'text/plain',
          }),
        hasCode('UNSAFE_PATH'),
      );
      assert.throws(
        () =>
          store.importBuffer({
            sessionId: 's',
            originalName: '.env.local',
            mimeType: 'text/plain',
            data: Buffer.from('secret'),
          }),
        hasCode('SECRET_FILENAME'),
      );
      assert.throws(
        () =>
          store.recordArtifact({
            sessionId: 's',
            title: 'bad',
            kind: 'file',
            path: 'results/api-key.txt',
          }),
        hasCode('SECRET_FILENAME'),
      );
      assert.throws(
        () =>
          store.recordArtifact({
            sessionId: 's',
            title: 'escaped',
            kind: 'file',
            path: 'escaped/result.txt',
          }),
        hasCode('UNSAFE_PATH'),
      );
      assert.throws(
        () => store.recordFileChange({ sessionId: 's', path: '/etc/passwd', kind: 'update' }),
        hasCode('UNSAFE_PATH'),
      );
    } finally {
      store.close();
    }
  });

  it('enforces the configured size limit for buffers and paths', () => {
    const { root, store } = fixture(4);
    mkdirSync(join(root, 'incoming'));
    writeFileSync(join(root, 'incoming', 'large.bin'), Buffer.alloc(5));
    try {
      assert.throws(
        () =>
          store.importBuffer({
            sessionId: 's',
            originalName: 'large.bin',
            mimeType: 'application/octet-stream',
            data: Buffer.alloc(5),
          }),
        hasCode('FILE_TOO_LARGE'),
      );
      assert.throws(
        () =>
          store.importPath({
            sessionId: 's',
            sourcePath: 'incoming/large.bin',
            mimeType: 'application/octet-stream',
          }),
        hasCode('FILE_TOO_LARGE'),
      );
    } finally {
      store.close();
    }
  });

  it('deduplicates by sha256 and removes a shared blob only after its last reference', () => {
    const { store } = fixture();
    try {
      const input = {
        originalName: 'same.txt',
        mimeType: 'text/plain',
        data: Buffer.from('same bytes'),
      };
      const first = store.importBuffer({ sessionId: 'one', ...input });
      const repeated = store.importBuffer({ sessionId: 'one', ...input });
      const shared = store.importBuffer({ sessionId: 'two', ...input });
      assert.equal(repeated.id, first.id, 'same session/hash returns the existing metadata row');
      assert.equal(
        shared.storedPath,
        first.storedPath,
        'sessions share the content-addressed blob',
      );
      const absolutePath = store.downloadMetadata('one', first.id).absolutePath;

      assert.equal(store.deleteAttachment('one', first.id), true);
      assert.equal(existsSync(absolutePath), true, 'second session still references the blob');
      assert.equal(store.deleteAttachment('two', shared.id), true);
      assert.equal(existsSync(absolutePath), false, 'last reference removal deletes the blob');
    } finally {
      store.close();
    }
  });
});

describe('artifacts, file changes, and session cascade', () => {
  it('records result metadata, reads managed files, and cascades rows and files', () => {
    const { root, store } = fixture();
    mkdirSync(join(root, 'results'));
    writeFileSync(join(root, 'results', 'report.txt'), 'result body');
    try {
      const attachment = store.importBuffer({
        sessionId: 'session-result',
        originalName: 'input.txt',
        mimeType: 'text/plain',
        data: Buffer.from('input'),
      });
      const artifact = store.recordArtifact({
        sessionId: 'session-result',
        title: 'Report',
        kind: 'text',
        path: 'results/report.txt',
        contentPreview: 'result body',
      });
      store.recordFileChange({
        sessionId: 'session-result',
        path: 'src/report.ts',
        kind: 'add',
        summary: 'Created report renderer',
      });

      assert.equal(store.readArtifact('session-result', artifact.id).toString(), 'result body');
      assert.equal(store.listArtifacts('session-result')[0]?.title, 'Report');
      assert.equal(store.listFileChanges('session-result')[0]?.kind, 'add');
      const blobPath = store.downloadMetadata('session-result', attachment.id).absolutePath;

      assert.equal(store.deleteSession('session-result'), true);
      assert.deepEqual(store.listAttachments('session-result'), []);
      assert.deepEqual(store.listArtifacts('session-result'), []);
      assert.deepEqual(store.listFileChanges('session-result'), []);
      assert.equal(existsSync(blobPath), false);
      assert.equal(existsSync(join(root, 'results', 'report.txt')), false);
      assert.equal(store.deleteSession('session-result'), false);
    } finally {
      store.close();
    }
  });

  it('deleteArtifact removes an unshared result file and leaves other records intact', () => {
    const { root, store } = fixture();
    mkdirSync(join(root, 'results'));
    writeFileSync(join(root, 'results', 'one.txt'), 'one');
    try {
      const artifact = store.recordArtifact({
        sessionId: 's',
        title: 'One',
        kind: 'text',
        path: 'results/one.txt',
      });
      store.recordFileChange({ sessionId: 's', path: 'src/one.ts', kind: 'update' });
      assert.equal(store.deleteArtifact('s', artifact.id), true);
      assert.equal(existsSync(join(root, 'results', 'one.txt')), false);
      assert.equal(store.listFileChanges('s').length, 1);
      assert.equal(store.deleteArtifact('s', artifact.id), false);
      assert.deepEqual(readdirSync(join(root, 'results')), []);
    } finally {
      store.close();
    }
  });

  it('keeps a managed blob until both its attachment and artifact references are removed', () => {
    const { store } = fixture();
    try {
      const attachment = store.importBuffer({
        sessionId: 'shared-result-session',
        originalName: 'shared.txt',
        mimeType: 'text/plain',
        data: Buffer.from('shared result'),
      });
      const artifact = store.recordArtifact({
        sessionId: 'shared-result-session',
        title: 'Shared result',
        kind: 'attachment',
        path: attachment.storedPath,
      });

      assert.equal(store.deleteAttachment('shared-result-session', attachment.id), true);
      assert.equal(
        store.readArtifact('shared-result-session', artifact.id).toString(),
        'shared result',
      );
      assert.equal(store.deleteArtifact('shared-result-session', artifact.id), true);
      assert.throws(
        () => store.readArtifact('shared-result-session', artifact.id),
        /Artifact not found/,
      );
    } finally {
      store.close();
    }
  });
});
