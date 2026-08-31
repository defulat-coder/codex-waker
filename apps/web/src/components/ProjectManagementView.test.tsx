import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LocalResourcesResponse, WakerProject } from '@waker/contracts';
import { ProjectManagementView } from './ProjectManagementView.js';

const originalFetch = globalThis.fetch;

const PROJECT: WakerProject = {
  id: 'project-one',
  wakerId: 'waker-one',
  name: '本地工作台',
  description: '主仓库',
  visibility: 'private',
  source: 'filesystem',
  path: '.',
  status: 'ready',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const emptyResources = (projects: WakerProject[]): LocalResourcesResponse => ({
  projects,
  automations: [],
  workflows: [],
  channels: [],
  tasks: [],
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ProjectManagementView', () => {
  it('网络中断时本地化错误并可重试恢复项目目录', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return json(emptyResources([PROJECT]));
    }) as typeof fetch;

    const view = render(<ProjectManagementView wakerId="waker-one" notify={() => {}} />);
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /项目暂时无法读取/);
    assert.doesNotMatch(alert.textContent ?? '', /Failed to fetch/);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    assert.ok(await screen.findByRole('heading', { name: PROJECT.name }));
    assert.ok(screen.getByText('就绪'));
    assert.equal(attempts, 2);
    assert.equal(view.container.querySelector('main'), null);
    assert.equal(view.container.querySelector('.memory-detail')?.tagName, 'SECTION');
  });

  it('创建、编辑并在展示真实影响后删除项目', async () => {
    let projects = [PROJECT];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ method, url, body });
      if (url.includes('/local-resources')) return json(emptyResources(projects));
      if (method === 'POST' && url.endsWith('/projects')) {
        const created = {
          ...PROJECT,
          ...body,
          id: 'project-two',
          updatedAt: '2026-08-28T01:00:00.000Z',
        } as WakerProject;
        projects = [...projects, created];
        return json(created, 201);
      }
      if (method === 'PATCH') {
        projects = projects.map((project) =>
          project.id === 'project-two'
            ? ({ ...project, ...body, updatedAt: '2026-08-28T02:00:00.000Z' } as WakerProject)
            : project,
        );
        return json(projects[1]);
      }
      if (url.includes('/delete-impact'))
        return json({
          projectId: 'project-two',
          sessionContexts: 2,
          tasks: 3,
          tasksPreserved: 3,
          automationDefinitions: 1,
          automationRuns: 4,
          automationTasksPreserved: 4,
          workflowDefinitions: 2,
          workflowRuns: 5,
          behavior: {
            sessionContexts: 'delete',
            tasks: 'detach-and-preserve',
            automationDefinitions: 'detach-and-pause',
            automationTasks: 'preserve',
            workflowDefinitions: 'detach-and-pause',
            workflowRuns: 'preserve',
          },
        });
      if (method === 'DELETE') {
        projects = projects.filter((project) => project.id !== 'project-two');
        return new Response(null, { status: 204 });
      }
      return json({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    const notices: Array<{ text: string; tone?: string }> = [];
    render(
      <ProjectManagementView
        wakerId="waker-one"
        notify={(text, tone) => notices.push({ text, tone })}
      />,
    );

    assert.ok(await screen.findByRole('heading', { name: '本地工作台' }));
    fireEvent.click(screen.getByRole('button', { name: /新建项目/ }));
    const createDialog = screen.getByRole('dialog', { name: '新建项目' });
    fireEvent.change(screen.getByLabelText('名称', { selector: 'input' }), {
      target: { value: '文档仓库' },
    });
    fireEvent.change(screen.getByLabelText('描述', { selector: 'textarea' }), {
      target: { value: '本地文档' },
    });
    fireEvent.change(screen.getByLabelText('可见性'), { target: { value: 'public' } });
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'git' } });
    fireEvent.change(screen.getByLabelText(/^本地路径/), { target: { value: 'docs' } });
    fireEvent.submit(createDialog);

    assert.ok(await screen.findByRole('heading', { name: '文档仓库' }));
    const create = calls.find((call) => call.method === 'POST');
    assert.deepEqual(create?.body, {
      wakerId: 'waker-one',
      name: '文档仓库',
      description: '本地文档',
      visibility: 'public',
      source: 'git',
      path: 'docs',
    });

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('名称', { selector: 'input' }), {
      target: { value: '知识仓库' },
    });
    fireEvent.change(screen.getByLabelText('可见性'), { target: { value: 'private' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    assert.ok(await screen.findByRole('heading', { name: '知识仓库' }));
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.equal((patch?.body as Record<string, unknown>).source, 'git');
    assert.equal((patch?.body as Record<string, unknown>).visibility, 'private');

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    assert.ok(await screen.findByText(/2 条会话项目关联/));
    const deleteDialog = screen.getByRole('dialog', { name: '删除项目：知识仓库' });
    assert.match(deleteDialog.textContent ?? '', /3 条任务会解除项目关联并保留历史与时间线/);
    assert.ok(screen.getByText(/1 个自动任务会解除项目关联并暂停/));
    assert.ok(screen.getByText(/4 条运行历史/));
    assert.ok(screen.getByText(/2 个工作流会解除项目关联并暂停/));
    assert.ok(screen.getByText(/5 条工作流运行历史会保留/));
    const deleteButton = screen.getByRole('button', { name: '删除项目' });
    assert.equal(deleteButton.hasAttribute('disabled'), true);
    fireEvent.change(screen.getByLabelText('输入项目名称以确认'), {
      target: { value: '知识仓库' },
    });
    assert.equal(deleteButton.hasAttribute('disabled'), false);
    fireEvent.click(deleteButton);
    assert.ok(await screen.findByRole('heading', { name: '本地工作台' }));
    assert.equal(screen.queryByRole('heading', { name: '知识仓库' }), null);
    assert.ok(calls.some((call) => call.url.includes('/delete-impact?wakerId=waker-one')));
    assert.ok(calls.some((call) => call.method === 'DELETE'));
    assert.deepEqual(notices, [
      { text: '项目已创建', tone: 'success' },
      { text: '项目已更新', tone: 'success' },
      { text: '项目已删除', tone: 'success' },
    ]);
  });

  it('展示加载失败恢复与空状态', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts === 1 ? json({ error: 'SQLite 暂时不可用' }, 500) : json(emptyResources([]));
    }) as typeof fetch;

    render(<ProjectManagementView wakerId="waker-one" notify={() => {}} />);
    assert.ok(await screen.findByRole('alert'));
    assert.ok(screen.getByText('SQLite 暂时不可用'));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    assert.ok(await screen.findByRole('heading', { name: '还没有项目' }));
  });

  it('删除影响读取失败时禁止删除并提供重试', async () => {
    let impactAttempts = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/local-resources')) return json(emptyResources([PROJECT]));
      if (url.includes('/delete-impact')) {
        impactAttempts += 1;
        return impactAttempts === 1
          ? json({ error: '影响检查失败' }, 500)
          : json({
              projectId: PROJECT.id,
              sessionContexts: 0,
              tasks: 0,
              automationDefinitions: 0,
              automationRuns: 0,
              automationTasksPreserved: 0,
              workflowDefinitions: 0,
              workflowRuns: 0,
              behavior: {
                sessionContexts: 'delete',
                tasks: 'cascade-delete',
                automationDefinitions: 'detach-and-pause',
                automationTasks: 'preserve',
                workflowDefinitions: 'detach-and-pause',
                workflowRuns: 'preserve',
              },
            });
      }
      return json({});
    }) as typeof fetch;

    render(<ProjectManagementView wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: PROJECT.name });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    assert.ok(await screen.findByText('影响检查失败'));
    assert.equal(screen.getByRole('button', { name: '删除项目' }).hasAttribute('disabled'), true);
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    assert.ok(await screen.findByText(/0 条会话项目关联/));
  });

  it('其他 Waker 的公开项目可见但保持只读', async () => {
    const shared = {
      ...PROJECT,
      id: 'shared',
      wakerId: 'another-waker',
      visibility: 'public' as const,
    };
    globalThis.fetch = (async (input) => {
      if (String(input).includes('/local-resources')) return json(emptyResources([shared]));
      return json({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    render(<ProjectManagementView wakerId="waker-one" notify={() => {}} />);
    assert.ok(await screen.findByRole('heading', { name: shared.name }));
    assert.ok(screen.getByText('其他 Waker 的公开项目（只读）'));
    assert.equal(
      (screen.getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled,
      true,
    );
    assert.equal(
      (screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled,
      true,
    );
  });
});
