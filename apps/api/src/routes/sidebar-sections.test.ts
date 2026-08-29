import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

describe('Sidebar sections API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-sidebar-sections-api-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.codex', 'agents', 'alpha.md'),
    `---\nname: alpha\nmark: a\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTest agent.\n`,
  );
  const app = buildApp(config, { cwd: root, schedulerIntervalMs: false });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function createSession(): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/agents/alpha/sessions' });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().id as string;
  }

  it('returns the empty default before the first write', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/alpha/sidebar-sections',
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.sections, []);
    assert.deepEqual(body.assignments, {});
    assert.deepEqual(body.entryOrder, []);
    assert.deepEqual(body.collapsed, []);
    assert.ok(typeof body.updatedAt === 'string' && body.updatedAt);
  });

  it('round-trips a full replace and preserves order/collapsed', async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();
    const payload = {
      sections: [
        { id: 'work', name: '工作', parentId: null, order: 2 },
        { id: 'work-sub', name: '子分组', parentId: 'work', order: 1 },
      ],
      assignments: { [sessionA]: 'work-sub' },
      entryOrder: ['work', sessionB],
      collapsed: ['work'],
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/agents/alpha/sidebar-sections',
      payload,
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().sections, payload.sections);
    assert.deepEqual(put.json().collapsed, ['work']);

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/alpha/sidebar-sections',
    });
    assert.equal(get.statusCode, 200, get.body);
    assert.deepEqual(get.json().sections, payload.sections);
    assert.deepEqual(get.json().assignments, { [sessionA]: 'work-sub' });
    assert.deepEqual(get.json().entryOrder, ['work', sessionB]);
    assert.deepEqual(get.json().collapsed, ['work']);
  });

  it('rejects session ids that do not belong to the agent', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/agents/alpha/sidebar-sections',
      payload: {
        sections: [{ id: 's', name: 'S', parentId: null, order: 0 }],
        assignments: { 'session_ghost': 's' },
      },
    });
    assert.equal(put.statusCode, 400, put.body);
    assert.match(put.json().error, /session_ghost/);
  });

  it('rejects structurally invalid payloads', async () => {
    const duplicate = await app.inject({
      method: 'PUT',
      url: '/api/v1/agents/alpha/sidebar-sections',
      payload: {
        sections: [
          { id: 's', name: 'S', parentId: null, order: 0 },
          { id: 's', name: 'S2', parentId: null, order: 1 },
        ],
      },
    });
    assert.equal(duplicate.statusCode, 400, duplicate.body);

    const nested = await app.inject({
      method: 'PUT',
      url: '/api/v1/agents/alpha/sidebar-sections',
      payload: {
        sections: [
          { id: 'a', name: 'A', parentId: null, order: 0 },
          { id: 'b', name: 'B', parentId: 'a', order: 0 },
          { id: 'c', name: 'C', parentId: 'b', order: 0 },
        ],
      },
    });
    assert.equal(nested.statusCode, 400, nested.body);
  });

  it('404s for unknown agents', async () => {
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/ghost-agent/sidebar-sections',
    });
    assert.equal(get.statusCode, 404, get.body);
  });
});
