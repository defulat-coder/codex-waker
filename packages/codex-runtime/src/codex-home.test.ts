import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { prepareProjectCodexHome } from './codex-home.js';

test('project Codex home keeps auth outside the repo and maps project runtime state', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-codex-home-'));
  const cwd = join(root, 'project');
  const userHome = join(root, 'user-codex');
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(userHome, { recursive: true });
  writeFileSync(join(userHome, 'auth.json'), '{"token":"secret"}');

  const runtimeHome = prepareProjectCodexHome(cwd, {
    userCodexHome: userHome,
    runtimeRoot,
  });

  const auth = join(runtimeHome, 'auth.json');
  assert.equal(lstatSync(auth).isSymbolicLink(), true);
  assert.equal(resolve(runtimeHome, readlinkSync(auth)), resolve(userHome, 'auth.json'));
  assert.equal(readFileSync(auth, 'utf8'), '{"token":"secret"}');
  assert.equal(lstatSync(join(runtimeHome, 'sessions')).isSymbolicLink(), true);
  assert.equal(
    resolve(runtimeHome, readlinkSync(join(runtimeHome, 'sessions'))),
    resolve(cwd, '.codex/sessions'),
  );
});
