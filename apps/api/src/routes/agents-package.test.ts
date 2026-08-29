import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  AgentSessionStore,
  getPreferences,
  readAgentSource,
  setPreference,
  writeAgentAvatar,
} from '@waker/codex-runtime';
import { KnowledgeStore } from '@waker/knowledge';
import { MemoryStore } from '@waker/memory';
import { WorkspaceStore } from '@waker/workspace-data';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';
import { unzipEntries, zipEntries } from '../lib/zip.js';

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
description: 整包导出导入测试 Agent。
suggestions:
  - 你好
---

你是 Alpha。
`;

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

const UNZIP_LIMITS = { maxEntries: 256, maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

function packageEntries(data: Buffer): Map<string, Buffer> {
  return new Map(unzipEntries(data, UNZIP_LIMITS).map((entry) => [entry.path, entry.data]));
}

describe('Agent package export/import API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-agent-package-api-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(join(root, '.codex', 'agents', 'alpha.md'), ALPHA);
  writeAgentAvatar(root, 'alpha', { mimeType: 'image/png', data: PNG_BYTES });

  const workspaceStore = new WorkspaceStore(join(root, '.codex', 'workspace.sqlite'));
  const sessionStore = new AgentSessionStore({ cwd: root });
  const memoryStore = new MemoryStore(join(root, '.codex', 'memory.sqlite'));
  const knowledgeStore = new KnowledgeStore(join(root, '.codex', 'knowledge.sqlite'));

  const project = workspaceStore.createProject({
    wakerId: 'alpha',
    visibility: 'private',
    name: 'Alpha Project',
    description: '导出用项目',
    source: 'filesystem',
    status: 'ready',
  });
  workspaceStore.createAutomation({
    wakerId: 'alpha',
    name: 'Alpha automation',
    kind: 'api',
    prompt: 'run alpha',
    projectId: project.id,
  });
  workspaceStore.createConnector({
    wakerId: 'alpha',
    name: 'alpha-mcp',
    transport: 'stdio',
    command: 'alpha-server',
    status: 'ready',
  });
  memoryStore.create({
    scope: { type: 'waker', id: 'alpha' },
    source: 'conversation',
    title: '用户偏好',
    content: '用户喜欢简洁的回答。\n',
  });
  const notebook = knowledgeStore.createNotebook({ name: 'Alpha Notebook' });
  knowledgeStore.bindNotebook(notebook.id, { scopeType: 'waker', scopeId: 'alpha' }, true);
  setPreference(root, 'thinking.alpha', 'high');

  const app = buildApp(config, {
    cwd: root,
    workspaceStore,
    sessionStore,
    memoryStore,
    knowledgeStore,
    schedulerIntervalMs: false,
  });

  let exportedZip: Buffer;

  before(async () => app.ready());
  after(async () => {
    await app.close();
    sessionStore.close();
    workspaceStore.close();
    memoryStore.close();
    knowledgeStore.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('exports a ZIP package with manifest, definition, avatar and scoped data', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agents/alpha/export-package' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['content-type'], 'application/zip');
    assert.match(String(response.headers['content-disposition']), /alpha\.wakerpack/);
    exportedZip = response.rawPayload;

    const entries = packageEntries(exportedZip);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    assert.equal(manifest.format, 'waker-agent-package');
    assert.equal(manifest.version, 1);
    assert.equal(manifest.agentId, 'alpha');
    assert.deepEqual(manifest.includes, {
      avatar: true,
      memories: true,
      projects: true,
      automations: true,
      workflows: false,
      connectors: true,
      preferences: true,
      knowledgeBindings: true,
    });
    assert.equal(entries.get('agent.md')!.toString('utf8'), readAgentSource(root, 'alpha'));
    assert.ok(entries.get('avatar.png')!.equals(PNG_BYTES));

    const memories = JSON.parse(entries.get('data/memories.json')!.toString('utf8'));
    assert.equal(memories.formatVersion, 1);
    assert.equal(memories.documents.length, 1);
    assert.equal(memories.documents[0].title, '用户偏好');

    const automations = JSON.parse(entries.get('data/automations.json')!.toString('utf8'));
    assert.equal(automations.length, 1);
    assert.equal(automations[0].name, 'Alpha automation');
    // 入站触发密钥不随包导出。
    assert.equal('triggerKey' in automations[0], false);

    const bindings = JSON.parse(entries.get('data/knowledge-bindings.json')!.toString('utf8'));
    assert.deepEqual(bindings, [
      { notebookId: notebook.id, notebookName: 'Alpha Notebook', canWrite: true },
    ]);
  });

  it('returns 404 when exporting an unknown agent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/ghost-agent/export-package',
    });
    assert.equal(response.statusCode, 404);
  });

  it('dry-run reports the plan without persisting anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?agentId=gamma&mode=dry-run',
      headers: { 'content-type': 'application/zip' },
      payload: exportedZip,
    });
    assert.equal(response.statusCode, 200, response.body);
    const report = response.json();
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.agentId, 'gamma');
    assert.equal(report.action, 'create');
    assert.deepEqual(report.contents, {
      avatar: true,
      memories: 1,
      projects: 1,
      automations: 1,
      workflows: 0,
      connectors: 1,
      preferences: 1,
      knowledgeBindings: 1,
    });
    assert.deepEqual(report.strippedFrontmatter, []);
    assert.deepEqual(report.skipped, []);
    // dry-run 不落任何数据。
    assert.equal(
      readFileSync(join(root, '.codex', 'agents', 'alpha.md'), 'utf8').includes('Alpha'),
      true,
    );
    const agents = await app.inject({ method: 'GET', url: '/api/v1/agents/gamma' });
    assert.equal(agents.statusCode, 404);
    assert.equal(memoryStore.list({ scope: { type: 'waker', id: 'gamma' } }).length, 0);
    assert.equal(workspaceStore.listAutomations('gamma').length, 0);
  });

  it('imports the package as a new agent with remapped ids and scope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?agentId=beta&mode=apply',
      headers: { 'content-type': 'application/zip' },
      payload: exportedZip,
    });
    assert.equal(response.statusCode, 201, response.body);
    const report = response.json();
    assert.equal(report.action, 'create');
    assert.deepEqual(report.failures, []);

    // 定义与头像落地。
    const beta = await app.inject({ method: 'GET', url: '/api/v1/agents/beta' });
    assert.equal(beta.statusCode, 200, beta.body);
    assert.equal(beta.json().name, 'Alpha');
    const betaAvatar = await app.inject({ method: 'GET', url: '/api/v1/agents/beta/avatar' });
    assert.equal(betaAvatar.statusCode, 200);
    assert.ok(betaAvatar.rawPayload.equals(PNG_BYTES));

    // memory 落到 beta 的 waker scope。
    const betaMemories = memoryStore.list({ scope: { type: 'waker', id: 'beta' } });
    assert.equal(betaMemories.length, 1);
    assert.equal(betaMemories[0]!.title, '用户偏好');

    // 项目/automation id 重新生成，projectId 映射到新项目。
    const betaProjects = workspaceStore
      .listProjects('beta')
      .filter((item) => item.wakerId === 'beta');
    assert.equal(betaProjects.length, 1);
    assert.notEqual(betaProjects[0]!.id, project.id);
    const betaAutomations = workspaceStore.listAutomations('beta');
    assert.equal(betaAutomations.length, 1);
    assert.equal(betaAutomations[0]!.projectId, betaProjects[0]!.id);
    assert.notEqual(betaAutomations[0]!.id, workspaceStore.listAutomations('alpha')[0]!.id);

    // connector 与 knowledge 绑定（notebook 复用本机已有实例）。
    assert.equal(workspaceStore.listConnectors('beta').length, 1);
    const betaBindings = knowledgeStore
      .listBindings()
      .filter((binding) => binding.scopeType === 'waker' && binding.scopeId === 'beta');
    assert.equal(betaBindings.length, 1);
    assert.equal(betaBindings[0]!.notebookId, notebook.id);
    assert.equal(betaBindings[0]!.canWrite, true);

    // thinking 偏好改写到 beta 维度。
    assert.equal(getPreferences(root)['thinking.beta'], 'high');
  });

  it('rejects re-import over an existing agent with 409 unless conflict=overwrite', async () => {
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?agentId=beta&mode=apply',
      headers: { 'content-type': 'application/zip' },
      payload: exportedZip,
    });
    assert.equal(conflict.statusCode, 409, conflict.body);

    const dryRunConflict = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?agentId=beta',
      headers: { 'content-type': 'application/zip' },
      payload: exportedZip,
    });
    assert.equal(dryRunConflict.statusCode, 409);

    const overwrite = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?agentId=beta&mode=apply&conflict=overwrite',
      headers: { 'content-type': 'application/zip' },
      payload: exportedZip,
    });
    assert.equal(overwrite.statusCode, 201, overwrite.body);
    assert.equal(overwrite.json().action, 'overwrite');
    // 覆盖是重建而不是叠加：同类数据先清后导。
    assert.equal(workspaceStore.listAutomations('beta').length, 1);
    assert.equal(memoryStore.list({ scope: { type: 'waker', id: 'beta' } }).length, 1);
  });

  it('rejects ZIP entries with path traversal', async () => {
    const malicious = zipEntries([
      { path: '../evil.md', data: Buffer.from('evil') },
      { path: 'manifest.json', data: Buffer.from('{}') },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?mode=apply',
      headers: { 'content-type': 'application/zip' },
      payload: malicious,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /非法路径/);

    const absolute = zipEntries([{ path: '/etc/passwd', data: Buffer.from('x') }]);
    const absoluteResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?mode=apply',
      headers: { 'content-type': 'application/zip' },
      payload: absolute,
    });
    assert.equal(absoluteResponse.statusCode, 400);
  });

  it('rejects a malformed ZIP body with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?mode=apply',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from('this is not a zip archive at all'),
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /ZIP/);
  });

  it('rejects an empty body with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?mode=apply',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.alloc(0),
    });
    assert.equal(response.statusCode, 400);
  });

  it('strips tool-ish frontmatter fields and reports them', async () => {
    const withTools = `---
name: Rogue
mark: R
tagline: 带工具声明
description: 试图声明工具的 Agent。
suggestions:
  - 你好
tools:
  - shell
sandbox: danger-full-access
---

你是 Rogue。
`;
    const roguePack = zipEntries([
      { path: 'agent.md', data: Buffer.from(withTools) },
      {
        path: 'manifest.json',
        data: Buffer.from(
          JSON.stringify({
            format: 'waker-agent-package',
            version: 1,
            agentId: 'rogue',
            name: 'Rogue',
            exportedAt: new Date().toISOString(),
            includes: {
              avatar: false,
              memories: false,
              projects: false,
              automations: false,
              workflows: false,
              connectors: false,
              preferences: false,
              knowledgeBindings: false,
            },
            files: [],
          }),
        ),
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/import-package?mode=apply',
      headers: { 'content-type': 'application/zip' },
      payload: roguePack,
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json().strippedFrontmatter, ['sandbox', 'tools']);
    const source = readAgentSource(root, 'rogue');
    assert.equal(source.includes('tools'), false);
    assert.equal(source.includes('sandbox'), false);
  });
});
