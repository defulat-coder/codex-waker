import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WorkspaceStore } from '@waker/workspace-data';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';
import { beginAgentDeletion, endAgentDeletion } from '../context.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

describe('Board API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-board-api-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  for (const id of ['alpha', 'beta']) {
    writeFileSync(
      join(root, '.codex', 'agents', `${id}.md`),
      `---\nname: ${id}\nmark: ${id[0]}\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTest agent.\n`,
    );
  }
  const store = new WorkspaceStore(join(root, '.codex', 'workspace.sqlite'));
  const project = store.createProject({
    wakerId: 'alpha',
    visibility: 'private',
    name: 'Alpha Project',
    description: '',
    source: 'filesystem',
    status: 'ready',
  });
  const automation = store.createAutomation({
    wakerId: 'alpha',
    name: 'Derived automation',
    kind: 'api',
    prompt: 'run',
    projectId: project.id,
  });
  const derivedTask = store.runAutomation('alpha', automation.id);
  const app = buildApp(config, { cwd: root, workspaceStore: store, schedulerIntervalMs: false });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists, filters and mutates only owner-scoped manual Tasks with CAS', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/board/tasks',
      payload: {
        wakerId: 'alpha',
        title: 'Manual release check',
        description: 'verify Board filtering',
        projectId: project.id,
        priority: 'high',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().managed, false);
    assert.equal(created.json().version, 1);
    assert.equal(created.json().projectName, 'Alpha Project');
    const taskId = created.json().id as string;

    const page = await app.inject({
      method: 'GET',
      url: `/api/v1/board/tasks?wakerId=alpha&query=release&status=queued&type=manual&sourceType=manual&projectId=${project.id}&sort=priority_desc&limit=1&offset=0`,
    });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().total, 1);
    assert.equal(page.json().items[0].id, taskId);
    assert.deepEqual(page.json().projects, [{ id: project.id, name: 'Alpha Project' }]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/board/tasks/${taskId}?wakerId=alpha`,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().events[0].label, 'created');
    assert.equal(detail.json().source.type, 'manual');
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/board/tasks/${taskId}?wakerId=beta`,
        })
      ).statusCode,
      404,
    );

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/board/tasks/${taskId}`,
      payload: { wakerId: 'alpha', expectedVersion: 1, status: 'completed' },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().status, 'completed');
    assert.equal(updated.json().version, 2);
    assert.ok(updated.json().completedAt);
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/board/tasks/${taskId}`,
          payload: { wakerId: 'alpha', expectedVersion: 1, title: 'stale' },
        })
      ).statusCode,
      409,
    );

    const impact = await app.inject({
      method: 'GET',
      url: `/api/v1/board/tasks/${taskId}/delete-impact?wakerId=alpha`,
    });
    assert.equal(impact.statusCode, 200, impact.body);
    assert.equal(impact.json().behavior, 'soft-delete');
    assert.equal(impact.json().events >= 2, true);
    assert.equal(impact.json().linkedRuns, 0);
    assert.equal(impact.json().linkedSessions, 0);

    for (const request of [
      app.inject({
        method: 'PATCH',
        url: `/api/v1/board/tasks/${derivedTask.id}`,
        payload: { wakerId: 'alpha', expectedVersion: derivedTask.version, title: 'forged' },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/board/tasks/${derivedTask.id}/delete-impact?wakerId=alpha`,
      }),
      app.inject({
        method: 'DELETE',
        url: `/api/v1/board/tasks/${derivedTask.id}?wakerId=alpha&expectedVersion=${derivedTask.version}`,
      }),
    ]) {
      assert.equal((await request).statusCode, 409);
    }

    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/board/tasks/${taskId}?wakerId=alpha&expectedVersion=2`,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/board/tasks/${taskId}?wakerId=alpha`,
        })
      ).statusCode,
      404,
    );
  });

  it('bounds Human Actions, enforces CAS and delegates Workflow actions', async () => {
    const resolveAction = store.createHumanAction({
      wakerId: 'alpha',
      source: 'codex',
      sourceId: 'session-resolve',
      sessionId: 'session-resolve',
      taskId: derivedTask.id,
      title: 'Resolve me',
      prompt: 'confirm',
    });
    const ignoreAction = store.createHumanAction({
      wakerId: 'alpha',
      source: 'codex',
      sourceId: 'session-ignore',
      sessionId: 'session-ignore',
      taskId: derivedTask.id,
      title: 'Ignore me',
      prompt: 'confirm',
    });
    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/board/human-actions?wakerId=alpha&status=pending&source=codex&limit=1&offset=0',
    });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().items.length, 1);
    assert.equal(page.json().total, 2);
    assert.equal(page.json().items[0].version, 1);

    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/board/human-actions/${resolveAction.id}/resolve`,
          payload: { wakerId: 'beta', expectedVersion: 1, result: true },
        })
      ).statusCode,
      404,
    );
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/board/human-actions/${resolveAction.id}/resolve`,
      payload: { wakerId: 'alpha', expectedVersion: 1, result: { approved: true } },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().status, 'handled');
    assert.equal(resolved.json().version, 2);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/board/human-actions/${resolveAction.id}/resolve`,
          payload: { wakerId: 'alpha', expectedVersion: 1, result: false },
        })
      ).statusCode,
      409,
    );
    const ignored = await app.inject({
      method: 'POST',
      url: `/api/v1/board/human-actions/${ignoreAction.id}/ignore`,
      payload: { wakerId: 'alpha', expectedVersion: 1 },
    });
    assert.equal(ignored.statusCode, 200, ignored.body);
    assert.equal(ignored.json().status, 'ignored');
    assert.equal(ignored.json().version, 2);

    const workflow = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Board approval',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'ask',
        nodes: [
          { id: 'ask', kind: 'ask_user', prompt: 'Continue?', inputKey: 'answer', next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded', output: '{{answer}}' },
        ],
      },
    });
    const queued = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${workflow.id}/run`,
      payload: { wakerId: 'alpha' },
    });
    assert.equal(queued.statusCode, 202, queued.body);
    const runId = queued.json().id as string;
    let workflowAction: { id: string; version: number } | undefined;
    for (let attempt = 0; attempt < 40 && !workflowAction; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/board/human-actions?wakerId=alpha&status=pending&source=workflow&limit=10&offset=0',
      });
      workflowAction = response
        .json()
        .items.find((item: { sourceId: string }) => item.sourceId === runId);
      if (!workflowAction) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(workflowAction);
    const workflowResolved = await app.inject({
      method: 'POST',
      url: `/api/v1/board/human-actions/${workflowAction.id}/resolve`,
      payload: { wakerId: 'alpha', expectedVersion: workflowAction.version, result: 'yes' },
    });
    assert.equal(workflowResolved.statusCode, 200, workflowResolved.body);
    assert.equal(workflowResolved.json().version, workflowAction.version + 1);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const run = store.getWorkflowRun('alpha', runId);
      if (run?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(store.getWorkflowRun('alpha', runId)?.status, 'succeeded');

    const queuedForIgnore = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${workflow.id}/run`,
      payload: { wakerId: 'alpha' },
    });
    assert.equal(queuedForIgnore.statusCode, 202, queuedForIgnore.body);
    const ignoredRunId = queuedForIgnore.json().id as string;
    let workflowIgnoreAction: { id: string; version: number } | undefined;
    for (let attempt = 0; attempt < 40 && !workflowIgnoreAction; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/board/human-actions?wakerId=alpha&status=pending&source=workflow&limit=10&offset=0',
      });
      workflowIgnoreAction = response
        .json()
        .items.find((item: { sourceId: string }) => item.sourceId === ignoredRunId);
      if (!workflowIgnoreAction) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(workflowIgnoreAction);
    const workflowIgnored = await app.inject({
      method: 'POST',
      url: `/api/v1/board/human-actions/${workflowIgnoreAction.id}/ignore`,
      payload: { wakerId: 'alpha', expectedVersion: workflowIgnoreAction.version },
    });
    assert.equal(workflowIgnored.statusCode, 200, workflowIgnored.body);
    assert.equal(workflowIgnored.json().status, 'ignored');
    assert.equal(workflowIgnored.json().version, workflowIgnoreAction.version + 1);
    assert.equal(store.getWorkflowRun('alpha', ignoredRunId)?.status, 'cancelled');
  });

  it('rejects writes during Waker deletion and keeps legacy forge routes disabled', async () => {
    const action = store.createHumanAction({
      wakerId: 'alpha',
      source: 'codex',
      sourceId: 'session-deletion-guard',
      sessionId: 'session-deletion-guard',
      title: 'blocked action',
      prompt: 'blocked',
    });
    assert.equal(beginAgentDeletion('alpha'), true);
    try {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/board/tasks',
            payload: { wakerId: 'alpha', title: 'blocked' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/board/human-actions/${action.id}/resolve`,
            payload: { wakerId: 'alpha', expectedVersion: action.version, result: true },
          })
        ).statusCode,
        409,
      );
    } finally {
      endAgentDeletion('alpha');
    }

    const legacyTask = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { wakerId: 'alpha', title: 'forge', type: 'manual' },
    });
    assert.ok([404, 410].includes(legacyTask.statusCode));
    assert.ok(
      [404, 410].includes(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${derivedTask.id}`,
            payload: { wakerId: 'alpha', status: 'completed' },
          })
        ).statusCode,
      ),
    );
    assert.ok(
      [404, 410].includes(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/tasks/${derivedTask.id}?wakerId=alpha`,
          })
        ).statusCode,
      ),
    );
    const legacyAction = await app.inject({
      method: 'POST',
      url: '/api/v1/human-actions',
      payload: {
        wakerId: 'alpha',
        source: 'codex',
        sourceId: 'forge',
        title: 'forge',
        prompt: 'forge',
      },
    });
    assert.ok([404, 410].includes(legacyAction.statusCode));
  });
});
