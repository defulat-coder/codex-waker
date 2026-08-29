import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '@waker/workspace-data';
import { GitPollJob, resolveGitHead } from './git-poller.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Git Poll Test', '-c', 'user.email=git-poll@test.local', '-C', dir, ...args],
    { encoding: 'utf8' },
  ).trim();
}

/** 真实临时 git 仓库：init + 一个文件提交，返回路径与头 commit。 */
function initRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'waker-git-poll-'));
  roots.push(dir);
  git(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'file.txt'), 'one\n');
  git(dir, ['add', 'file.txt']);
  git(dir, ['commit', '-m', 'first']);
  return { dir, head: git(dir, ['rev-parse', 'HEAD']) };
}

function commitAgain(dir: string, content: string): string {
  writeFileSync(join(dir, 'file.txt'), content);
  git(dir, ['add', 'file.txt']);
  git(dir, ['commit', '-m', `commit ${content}`]);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('git poll head resolution', () => {
  it('reads the branch head from a local path and from a file:// URL without fetching', async () => {
    const { dir, head } = initRepo();
    const local = await resolveGitHead(dir, null);
    assert.equal(local.commit, head);
    assert.equal(local.branch, 'main');
    const named = await resolveGitHead(dir, 'main');
    assert.equal(named.commit, head);
    const remote = await resolveGitHead(`file://${dir}`, 'main');
    assert.equal(remote.commit, head);
    const remoteHead = await resolveGitHead(`file://${dir}`, null);
    assert.equal(remoteHead.commit, head);
    await assert.rejects(() => resolveGitHead(`file://${dir}`, 'no-such-branch'), /ls-remote/);
  });
});

describe('GitPollJob', () => {
  it('seeds a baseline, fires once per new commit and stays quiet otherwise', async () => {
    const { dir, head: first } = initRepo();
    const store = new WorkspaceStore(':memory:');
    let now = 1_000_000;
    const enqueued: string[] = [];
    const job = new GitPollJob({
      store,
      wakerIds: () => ['waker-one'],
      enqueue: (_wakerId, runId) => enqueued.push(runId),
      now: () => now,
    });
    try {
      const automation = store.createAutomation({
        wakerId: 'waker-one',
        name: 'Watch repo',
        kind: 'git-poll',
        prompt: 'Handle new commits',
        repo: dir,
      });
      // First tick only records the baseline cursor.
      assert.deepEqual(await job.tick(), []);
      assert.equal(store.getAutomation('waker-one', automation.id)!.lastSeenCommit, first);
      assert.equal(enqueued.length, 0);
      // A new commit within the poll interval is not re-checked yet.
      const second = commitAgain(dir, 'two\n');
      assert.deepEqual(await job.tick(), []);
      // After the interval the move fires exactly one git-triggered run.
      now += 61_000;
      const runs = await job.tick();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.trigger, 'git');
      assert.deepEqual(runs[0]!.input, {
        source: 'git-poll',
        repo: dir,
        branch: 'main',
        beforeCommit: first,
        afterCommit: second,
      });
      assert.deepEqual(enqueued, [runs[0]!.id]);
      assert.equal(store.getAutomation('waker-one', automation.id)!.lastSeenCommit, second);
      // While the run is active, newer commits wait for the next free slot.
      const third = commitAgain(dir, 'three\n');
      now += 61_000;
      assert.deepEqual(await job.tick(), []);
      store.cancelAutomationRun('waker-one', runs[0]!.id);
      now += 61_000;
      const followUp = await job.tick();
      assert.equal(followUp.length, 1);
      assert.equal(
        (followUp[0]!.input as { beforeCommit: string }).beforeCommit,
        second,
      );
      assert.equal((followUp[0]!.input as { afterCommit: string }).afterCommit, third);
      store.cancelAutomationRun('waker-one', followUp[0]!.id);
      // No new commit: subsequent ticks stay quiet.
      now += 61_000;
      assert.deepEqual(await job.tick(), []);
    } finally {
      store.close();
    }
  });

  it('polls remote URLs via ls-remote (file:// fixture)', async () => {
    const { dir, head: first } = initRepo();
    const store = new WorkspaceStore(':memory:');
    let now = 1_000_000;
    const enqueued: string[] = [];
    const job = new GitPollJob({
      store,
      wakerIds: () => ['waker-one'],
      enqueue: (_wakerId, runId) => enqueued.push(runId),
      now: () => now,
    });
    try {
      const automation = store.createAutomation({
        wakerId: 'waker-one',
        name: 'Watch remote',
        kind: 'git-poll',
        prompt: 'Handle new commits',
        repo: `file://${dir}`,
        branch: 'main',
      });
      assert.deepEqual(await job.tick(), []);
      assert.equal(store.getAutomation('waker-one', automation.id)!.lastSeenCommit, first);
      const second = commitAgain(dir, 'two\n');
      now += 61_000;
      const runs = await job.tick();
      assert.equal(runs.length, 1);
      assert.equal((runs[0]!.input as { afterCommit: string }).afterCommit, second);
    } finally {
      store.close();
    }
  });

  it('logs poll failures without crashing and retries next round', async () => {
    const root = mkdtempSync(join(tmpdir(), 'waker-git-poll-broken-'));
    roots.push(root);
    const notARepo = join(root, 'not-a-repo');
    mkdirSync(notARepo);
    const store = new WorkspaceStore(':memory:');
    let now = 1_000_000;
    const warnings: string[] = [];
    const job = new GitPollJob({
      store,
      wakerIds: () => ['waker-one'],
      enqueue: () => undefined,
      now: () => now,
      logger: { info: () => undefined, warn: (message) => warnings.push(message) },
    });
    try {
      const automation = store.createAutomation({
        wakerId: 'waker-one',
        name: 'Watch broken',
        kind: 'git-poll',
        prompt: 'Handle new commits',
        repo: notARepo,
      });
      assert.deepEqual(await job.tick(), []);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /waker-git-poll/);
      assert.equal(store.getAutomation('waker-one', automation.id)!.lastSeenCommit, null);
      // 失败不炸调度器：下一轮继续重试，同样只记日志。
      now += 61_000;
      assert.deepEqual(await job.tick(), []);
      assert.equal(warnings.length, 2);
      // Disabled automations are never polled.
      store.updateAutomation('waker-one', automation.id, { enabled: false });
      now += 61_000;
      assert.deepEqual(await job.tick(), []);
      assert.equal(warnings.length, 2);
    } finally {
      store.close();
    }
  });
});
