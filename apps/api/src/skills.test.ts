import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionStore } from '@waker/codex-runtime';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

describe('skills endpoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-api-skills-'));
  mkdirSync(join(root, '.agents', 'skills', 'web-research'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'skills', 'web-research', 'SKILL.md'),
    '---\nname: web-research\ndescription: 联网调研。\n---\n\n## 步骤\n\n1. 先搜索。\n',
  );
  writeFileSync(
    join(root, 'skills-lock.json'),
    JSON.stringify({ version: 1, skills: { 'web-research': { source: 'acme/skills' } } }),
  );

  const sessions = new AgentSessionStore({ cwd: root });
  const app = buildApp(config, { cwd: root, sessionStore: sessions });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /skills/installed lists skills with scope and lockfile source', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/skills/installed' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.total, 1);
    assert.deepEqual(body.items[0].name, 'web-research');
    assert.equal(body.items[0].scope, 'agents');
    assert.equal(body.items[0].source, 'acme/skills');
  });

  it('GET /skills/installed/content returns the full body with frontmatter stripped', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/installed/content?scope=agents&name=web-research',
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.content, '## 步骤\n\n1. 先搜索。');
    assert.equal(body.frontmatter, 'name: web-research\ndescription: 联网调研。');
    assert.equal(body.source, 'acme/skills');
  });

  it('GET /skills/installed/content validates scope/name and 404s unknown skills', async () => {
    const badScope = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/installed/content?scope=elsewhere&name=web-research',
    });
    assert.equal(badScope.statusCode, 400);
    const traversal = await app.inject({
      method: 'GET',
      url: `/api/v1/skills/installed/content?scope=agents&name=${encodeURIComponent('../settings')}`,
    });
    assert.equal(traversal.statusCode, 400);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/installed/content?scope=codex&name=web-research',
    });
    assert.equal(missing.statusCode, 404);
  });

  it('GET /skills/library/detail validates source/skillId before any fetch', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: `/api/v1/skills/library/detail?source=${encodeURIComponent('evil; rm -rf')}&skillId=x`,
    });
    assert.equal(bad.statusCode, 400);
    const badId = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/library/detail?source=acme/skills&skillId=a/b',
    });
    assert.equal(badId.statusCode, 400);
  });
});

describe('skills upload endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-api-skills-upload-'));
  const app = buildApp(config, { cwd: root });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('POST /skills/upload writes .codex/skills/<name>/SKILL.md and returns 201', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/upload',
      payload: { name: 'hand-made', content: '手工上传的正文。', description: '手工上传。' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.name, 'hand-made');
    assert.equal(body.scope, 'codex');
    assert.equal(body.path, '.codex/skills/hand-made/SKILL.md');
    const written = readFileSync(join(root, '.codex', 'skills', 'hand-made', 'SKILL.md'), 'utf8');
    assert.match(written, /^---\nname: "hand-made"/);
    assert.match(written, /手工上传的正文。/);
    // 上传后能进已安装列表并能读出完整内容。
    const listed = await app.inject({ method: 'GET', url: '/api/v1/skills/installed' });
    assert.equal(listed.json().total, 1);
    const content = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/installed/content?scope=codex&name=hand-made',
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.json().content, '手工上传的正文。');
  });

  it('POST /skills/upload maps conflicts to 409 and invalid input to 400', async () => {
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/upload',
      payload: { name: 'hand-made', content: '重复上传。' },
    });
    assert.equal(conflict.statusCode, 409);
    const badName = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/upload',
      payload: { name: 'Bad Name', content: '正文。' },
    });
    assert.equal(badName.statusCode, 400);
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/upload',
      payload: { name: 'empty-skill', content: '' },
    });
    assert.equal(empty.statusCode, 400);
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/upload',
      payload: { name: 'big-skill', content: '长'.repeat(200 * 1024) },
    });
    assert.equal(tooLarge.statusCode, 400);
  });

  it('POST /skills/remove deletes an uploaded skill directly and returns the list', async () => {
    const removed = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/remove',
      payload: { name: 'hand-made', scope: 'codex' },
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().total, 0);
    assert.equal(existsSync(join(root, '.codex', 'skills', 'hand-made')), false);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/remove',
      payload: { name: 'hand-made', scope: 'codex' },
    });
    assert.equal(missing.statusCode, 404);
  });

  it('POST /skills/remove 404s skills that are not installed and rejects traversal-shaped names', async () => {
    // 未安装（且未显式给 scope）：直接 404，不透传给 skills CLI。
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/remove',
      payload: { name: 'ghost-skill' },
    });
    assert.equal(unknown.statusCode, 404);
    // 纯点号 / 连续点的名字在 schema 层就被拒（目录遍历形态）。
    for (const name of ['..', '.', 'a..b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/skills/remove',
        payload: { name, scope: 'codex' },
      });
      assert.equal(response.statusCode, 400, `名字 ${name} 应被 pattern 拒绝`);
    }
  });
});
