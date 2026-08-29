import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AgentSessionStore } from '@waker/codex-runtime';
import { WorkspaceStore } from '@waker/workspace-data';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

const ALPHA = `---
name: Alpha
mark: A
tagline: 测试角色
description: 带关于我区块的测试 Agent。
suggestions:
  - 你好
strengths:
  - title: "用例设计"
    text: "覆盖正常路径与边界值。"
workStyles:
  - title: "风险驱动"
    text: "先评估风险再动手。"
---

你是 Alpha。
`;

describe('Agent home API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-agent-home-api-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(join(root, '.codex', 'agents', 'alpha.md'), ALPHA);
  writeFileSync(
    join(root, '.codex', 'agents', 'beta.md'),
    `---\nname: Beta\nmark: B\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTest agent.\n`,
  );
  const workspaceStore = new WorkspaceStore(join(root, '.codex', 'workspace.sqlite'));
  const sessionStore = new AgentSessionStore({ cwd: root });
  const project = workspaceStore.createProject({
    wakerId: 'alpha',
    visibility: 'private',
    name: 'Alpha Project',
    description: '',
    source: 'filesystem',
    status: 'ready',
  });
  const automation = workspaceStore.createAutomation({
    wakerId: 'alpha',
    name: 'Alpha automation',
    kind: 'api',
    prompt: 'run',
    projectId: project.id,
  });
  workspaceStore.runAutomation('alpha', automation.id);
  const app = buildApp(config, {
    cwd: root,
    workspaceStore,
    sessionStore,
    schedulerIntervalMs: false,
  });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    sessionStore.close();
    workspaceStore.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 404 for an unknown agent', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/ghost-agent/home' });
    assert.equal(response.statusCode, 404);
  });

  it('returns real counts, activity and createdAt', async () => {
    await sessionStore.createSession('alpha', 'session_home_1');
    await sessionStore.createSession('alpha', 'session_home_2');
    await sessionStore.createSession('beta', 'session_home_beta');

    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/alpha/home' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    // 计数与 delete-impact 同源：只统计当前 Agent 的资源。
    assert.equal(body.counts.sessions, 2);
    assert.equal(body.counts.questions, 0);
    assert.equal(body.counts.automations, 1);
    assert.equal(body.counts.projects, 1);
    assert.equal(body.counts.workflows, 0);
    assert.ok(body.counts.tasks >= 1);
    // createdAt 取定义文件 birthtime；文件系统不提供时为 null，两者都合法。
    if (body.createdAt !== null) assert.ok(!Number.isNaN(new Date(body.createdAt).getTime()));
    // 活跃度按 updated_at 的日期分组：两个会话都落在同一天。
    assert.equal(body.activity.length, 1);
    assert.match(body.activity[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.activity[0].count, 2);
  });

  it('scopes counts and activity to the requested agent', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/beta/home' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.counts.sessions, 1);
    assert.equal(body.counts.automations, 0);
    assert.equal(body.counts.projects, 0);
    assert.equal(body.activity.length, 1);
    assert.equal(body.activity[0].count, 1);
  });

  it('exposes strengths/workStyles on the agent detail endpoint', async () => {
    const withSections = await app.inject({ method: 'GET', url: '/api/v1/agents/alpha' });
    assert.equal(withSections.statusCode, 200, withSections.body);
    assert.deepEqual(withSections.json().strengths, [
      { title: '用例设计', text: '覆盖正常路径与边界值。' },
    ]);
    assert.deepEqual(withSections.json().workStyles, [
      { title: '风险驱动', text: '先评估风险再动手。' },
    ]);
    const plain = await app.inject({ method: 'GET', url: '/api/v1/agents/beta' });
    assert.equal(plain.json().strengths, undefined);
  });
});
