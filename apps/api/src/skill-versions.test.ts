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

const SKILL_V1 = '---\nname: web-research\ndescription: 联网调研 v1。\n---\n\n1. 先搜索。\n';
const SKILL_V2 = '---\nname: web-research\ndescription: 联网调研 v2。\n---\n\n1. 先搜索。\n2. 再核对。\n';

describe('skill versions endpoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-api-skill-versions-'));
  const skillDir = join(root, '.agents', 'skills', 'web-research');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_V1);

  const sessions = new AgentSessionStore({ cwd: root });
  const app = buildApp(config, { cwd: root, sessionStore: sessions });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('POST /skills/snapshots creates a labelled manual version', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/snapshots',
      payload: { label: '基线' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.created, true);
    assert.equal(body.version.id, 'v000001');
    assert.equal(body.version.label, '基线');
    assert.equal(body.version.trigger, 'manual');
    assert.deepEqual(body.version.changes.added, ['web-research/SKILL.md']);
    assert.match(body.version.fingerprint, /^[0-9a-f]{64}$/);
  });

  it('POST /skills/snapshots dedupes an unchanged tree', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/snapshots',
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().created, false);
    assert.equal(response.json().version.id, 'v000001');
  });

  it('GET /skills/versions auto-versions drift and lists summaries', async () => {
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_V2);
    writeFileSync(join(skillDir, 'refs.md'), '参考资料。\n');
    const response = await app.inject({ method: 'GET', url: '/api/v1/skills/versions' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.total, 2);
    const latest = body.items[1];
    assert.equal(latest.id, 'v000002');
    assert.equal(latest.trigger, 'auto');
    assert.deepEqual(latest.changes.added, ['web-research/refs.md']);
    assert.deepEqual(latest.changes.modified, ['web-research/SKILL.md']);
    // 列表项不带 files 明细。
    assert.equal(latest.files, undefined);
  });

  it('GET /skills/versions/:versionId returns the detail and validates ids', async () => {
    const detail = await app.inject({ method: 'GET', url: '/api/v1/skills/versions/v000001' });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(
      detail.json().files.map((file: { path: string }) => file.path),
      ['web-research/SKILL.md'],
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/skills/versions/v000099' })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/skills/versions/bad-id' })).statusCode,
      400,
    );
  });

  it('GET /skills/diff diffs two versions and supports to=current', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/diff?from=v000001&to=v000002',
    });
    assert.equal(response.statusCode, 200);
    const files = response.json().files;
    const byPath = new Map<string, { path: string; status?: string; diff?: string }>(
      files.map((file: { path: string }) => [file.path, file]),
    );
    const modified = byPath.get('web-research/SKILL.md');
    assert.equal(modified?.status, 'modified');
    assert.match(modified?.diff ?? '', /^-description: 联网调研 v1。$/m);
    assert.match(modified?.diff ?? '', /^\+description: 联网调研 v2。$/m);
    assert.equal(byPath.get('web-research/refs.md')?.status, 'added');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/diff?from=v000001&to=v000099',
    });
    assert.equal(missing.statusCode, 404);
    const badQuery = await app.inject({ method: 'GET', url: '/api/v1/skills/diff?from=v000001' });
    assert.equal(badQuery.statusCode, 400);

    writeFileSync(join(skillDir, 'draft.md'), '未记版。\n');
    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/skills/diff?from=v000002&to=current',
    });
    assert.equal(current.statusCode, 200);
    assert.ok(
      current
        .json()
        .files.some(
          (file: { path: string; status: string }) =>
            file.path === 'web-research/draft.md' && file.status === 'added',
        ),
    );
  });

  it('POST /skills/rollback is a dry-run by default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/rollback',
      payload: { versionId: 'v000001' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.applied, false);
    assert.deepEqual(body.plan.restore, ['web-research/SKILL.md']);
    assert.deepEqual(body.plan.delete.sort(), ['web-research/draft.md', 'web-research/refs.md']);
    // dry-run 不写盘。
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), SKILL_V2);
    assert.equal(existsSync(join(skillDir, 'draft.md')), true);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/rollback',
      payload: { versionId: 'v000099' },
    });
    assert.equal(missing.statusCode, 404);
  });

  it('POST /skills/rollback apply=true writes after a pre-snapshot', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/rollback',
      payload: { versionId: 'v000001', apply: true, reason: '回退实验' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.applied, true);
    assert.equal(body.preSnapshotId, 'v000003');
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), SKILL_V1);
    assert.equal(existsSync(join(skillDir, 'refs.md')), false);
    assert.equal(existsSync(join(skillDir, 'draft.md')), false);

    const versions = (await app.inject({ method: 'GET', url: '/api/v1/skills/versions' })).json();
    const pre = versions.items.find((item: { id: string }) => item.id === 'v000003');
    assert.equal(pre.trigger, 'rollback');
    assert.match(pre.label, /回滚至 v000001 前自动快照/);
    assert.match(pre.label, /回退实验/);

    // 反悔：回滚到 pre-snapshot 恢复 v2 + refs.md；draft.md 也被 v000003 归档，一并恢复。
    const undo = await app.inject({
      method: 'POST',
      url: '/api/v1/skills/rollback',
      payload: { versionId: 'v000003', apply: true },
    });
    assert.equal(undo.statusCode, 200);
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), SKILL_V2);
    assert.equal(existsSync(join(skillDir, 'refs.md')), true);
    assert.equal(existsSync(join(skillDir, 'draft.md')), true);
  });
});
