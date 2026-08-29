import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@waker/memory';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import { MemoryMaintenanceJob } from './memory-maintenance.js';

const baseConfig: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
  WAKER_MEMORY_MAINTENANCE: 'off',
};

const AGENT_FILE = [
  '---',
  'name: "Codex 助手"',
  'mark: "⌘"',
  'tagline: "通用聊天助手"',
  'description: "测试用 agent。"',
  'suggestions:',
  '  - "你好"',
  '---',
  '',
  '你是 Codex 助手。',
  '',
].join('\n');

/** 相对真实时间的日期：维护的 stale 判定用的是真实 now。 */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'waker-memory-maintenance-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(join(root, '.codex', 'agents', 'codex-assistant.md'), AGENT_FILE);
  return root;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('memory maintenance route', () => {
  const root = makeProjectRoot();
  let storeNow = new Date('2024-01-01T00:00:00.000Z');
  const memory = new MemoryStore(':memory:', { now: () => storeNow });
  const app = buildApp(baseConfig, {
    cwd: root,
    memoryStore: memory,
    schedulerIntervalMs: false,
  });
  after(async () => {
    await app.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('POST /api/v1/memory/maintenance/run returns a real report', async () => {
    const scope = { type: 'waker', id: 'codex-assistant' } as const;
    storeNow = daysAgo(120);
    memory.create({ scope, source: 'conversation', title: '旧记忆', content: '# 旧记忆\n\nx' });
    storeNow = new Date();
    memory.create({ scope, source: 'manual', title: '重复', content: '# 重复\n\nv1' });
    memory.create({ scope, source: 'manual', title: '重复', content: '# 重复\n\nv2' });
    memory.create({ scope, source: 'manual', title: '新记忆', content: '# 新记忆\n\ny' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/maintenance/run',
      payload: { scope },
    });
    assert.equal(response.statusCode, 200);
    const report = response.json() as {
      scope: { type: string; id: string };
      trigger: string;
      checked: number;
      deleted: number;
      snapshotted: number;
      skipped: number;
      actions: Array<{ action: string; reason: string; snapshotId?: string }>;
    };
    assert.deepEqual(report.scope, scope);
    assert.equal(report.trigger, 'manual');
    assert.equal(report.checked, 4);
    // 1 条陈旧归档 + 1 条同标题压实；其余 2 条跳过。
    assert.equal(report.deleted, 2);
    assert.equal(report.snapshotted, 2);
    assert.equal(report.skipped, 2);
    assert.equal(report.actions.length, 4);
    assert.ok(
      report.actions
        .filter((entry) => entry.action === 'deleted')
        .every((entry) => entry.snapshotId),
    );
    // 时间线里能看到维护产生的真实 delete 记录。
    const timeline = memory.listTimeline({ scope, action: 'delete' });
    assert.equal(timeline.length, 2);
    assert.equal(memory.list({ scope }).length, 2);
  });

  it('rejects an invalid body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/maintenance/run',
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('memory maintenance job', () => {
  it('runs due scopes once per runEveryMs with trigger cron', async () => {
    const memory = new MemoryStore(':memory:');
    try {
      memory.create({
        scope: { type: 'waker', id: 'w1' },
        source: 'manual',
        title: '记忆',
        content: '# 记忆\n\nx',
      });
      let now = 1_000_000;
      const job = new MemoryMaintenanceJob({
        memory,
        scopeIds: () => ['w1'],
        now: () => now,
        runEveryMs: 100_000,
      });
      const first = await job.tick();
      assert.equal(first.length, 1);
      assert.equal(first[0]?.trigger, 'cron');
      assert.equal(first[0]?.checked, 1);
      assert.equal((await job.tick()).length, 0);
      now += 100_000;
      assert.equal((await job.tick()).length, 1);
    } finally {
      memory.close();
    }
  });

  it('does nothing when disabled', async () => {
    const memory = new MemoryStore(':memory:');
    try {
      const job = new MemoryMaintenanceJob({
        memory,
        scopeIds: () => ['w1'],
        enabled: false,
      });
      job.start();
      assert.deepEqual(await job.tick(), []);
      job.stop();
    } finally {
      memory.close();
    }
  });
});

describe('memory maintenance scheduler wiring', () => {
  it('does not start the cron job when WAKER_MEMORY_MAINTENANCE=off', async () => {
    const root = makeProjectRoot();
    const storeNow = daysAgo(120);
    const memory = new MemoryStore(':memory:', { now: () => storeNow });
    const app = buildApp(baseConfig, {
      cwd: root,
      memoryStore: memory,
      schedulerIntervalMs: false,
      memoryMaintenanceRuntime: { checkIntervalMs: 5, runEveryMs: 0 },
    });
    try {
      memory.create({
        scope: { type: 'waker', id: 'codex-assistant' },
        source: 'manual',
        title: '陈旧记忆',
        content: '# 陈旧记忆\n\nx',
      });
      await app.ready();
      await sleep(40);
      assert.equal(memory.list({ scope: { type: 'waker', id: 'codex-assistant' } }).length, 1);
      assert.equal(memory.listTimeline({ action: 'delete' }).length, 0);
    } finally {
      await app.close();
      memory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the cron job daily when enabled', async () => {
    const root = makeProjectRoot();
    const storeNow = daysAgo(120);
    const memory = new MemoryStore(':memory:', { now: () => storeNow });
    const config: AppConfig = { ...baseConfig };
    delete config.WAKER_MEMORY_MAINTENANCE;
    const app = buildApp(config, {
      cwd: root,
      memoryStore: memory,
      schedulerIntervalMs: false,
      memoryMaintenanceRuntime: { checkIntervalMs: 5, runEveryMs: 0 },
    });
    try {
      memory.create({
        scope: { type: 'waker', id: 'codex-assistant' },
        source: 'manual',
        title: '陈旧记忆',
        content: '# 陈旧记忆\n\nx',
      });
      await app.ready();
      await sleep(40);
      assert.equal(memory.list({ scope: { type: 'waker', id: 'codex-assistant' } }).length, 0);
      assert.equal(memory.listTimeline({ action: 'delete' }).length, 1);
    } finally {
      await app.close();
      memory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
