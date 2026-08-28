import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveProjectDirectory } from './project-path.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveProjectDirectory', () => {
  it('canonicalizes workspace-contained filesystem and Git directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'waker-project-root-'));
    roots.push(root);
    mkdirSync(join(root, 'filesystem'));
    mkdirSync(join(root, 'checkout', '.git'), { recursive: true });

    assert.equal(
      resolveProjectDirectory(root, 'filesystem', 'filesystem').storedPath,
      'filesystem',
    );
    assert.equal(
      resolveProjectDirectory(root, join(root, 'checkout'), 'git').storedPath,
      'checkout',
    );
    assert.equal(resolveProjectDirectory(root, '.', 'filesystem').storedPath, '.');
  });

  it('rejects missing, non-directory, non-Git and escaped paths including symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'waker-project-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'waker-project-outside-'));
    roots.push(root, outside);
    mkdirSync(join(root, 'plain'));
    writeFileSync(join(root, 'file.txt'), 'not a directory');
    symlinkSync(outside, join(root, 'escape'));

    assert.throws(() => resolveProjectDirectory(root, 'missing'), /不存在或不可读取/);
    assert.throws(() => resolveProjectDirectory(root, 'file.txt'), /不是目录/);
    assert.throws(() => resolveProjectDirectory(root, 'plain', 'git'), /本地检出目录/);
    assert.throws(() => resolveProjectDirectory(root, '../outside'), /必须位于当前工作区内|不存在/);
    assert.throws(() => resolveProjectDirectory(root, 'escape'), /必须位于当前工作区内/);
  });
});
