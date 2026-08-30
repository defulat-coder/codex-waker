import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentTemplate } from '@waker/contracts';
import { NewAgentDialog } from './NewAgentDialog.js';

const originalFetch = globalThis.fetch;

const TEMPLATE: AgentTemplate = {
  id: 'translator-pro',
  name: '中英翻译助手',
  mark: '译',
  tagline: '中英互译与润色',
  description: '在中英文之间互译，保留语气与格式。',
  suggestions: ['把这段话译成英文'],
  body: '你是中英翻译助手，专注中英互译。',
  hasAvatar: true,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; method: string; body?: Record<string, unknown> };

function installApi(calls: Call[], options: { failAvatar?: boolean } = {}) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.startsWith('/avatars/high-quality-100/'))
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    if (url.endsWith('/api/v1/agent-templates/translator-pro/avatar'))
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    if (url.endsWith('/api/v1/agent-templates')) return json({ items: [TEMPLATE] });
    if (url.endsWith('/api/v1/agents') && method === 'POST') {
      return json({ id: body?.id, name: body?.name, mark: body?.mark }, 201);
    }
    if (url.includes('/api/v1/agents/') && url.endsWith('/avatar') && method === 'PUT') {
      if (options.failAvatar) return json({ error: '头像文件不能超过 2 MB' }, 413);
      return json({ id: 'translator-pro' }, 200);
    }
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderDialog(props: Partial<Parameters<typeof NewAgentDialog>[0]> = {}) {
  const created: string[] = [];
  const avatarErrors: string[] = [];
  render(
    <NewAgentDialog
      open
      onClose={() => {}}
      onCreated={(id) => created.push(id)}
      hostName="test-host"
      onAvatarError={(message) => avatarErrors.push(message)}
      {...props}
    />,
  );
  return { created, avatarErrors };
}

function nameInput(): HTMLInputElement {
  return screen.getByPlaceholderText('请输入 Waker 名称') as HTMLInputElement;
}

function submitDialog() {
  fireEvent.click(screen.getByRole('button', { name: '保存并启用' }));
}

describe('NewAgentDialog', () => {
  it('removes the dialog from the accessibility tree immediately when closed', async () => {
    installApi([]);
    const props = {
      onClose: () => {},
      onCreated: () => {},
      hostName: 'test-host',
    };
    const { rerender } = render(<NewAgentDialog {...props} open />);
    await screen.findByRole('dialog', { name: '新建 Waker' });

    rerender(<NewAgentDialog {...props} open={false} />);

    assert.equal(screen.queryByRole('dialog'), null);
  });

  it('renders the role gallery from API data with legacy copy and the runtime section', async () => {
    const calls: Call[] = [];
    installApi(calls);
    renderDialog();
    const option = await screen.findByRole('option', { name: /中英翻译助手/ });
    assert.equal(option.getAttribute('aria-selected'), 'false');
    assert.equal(
      option.querySelector('img')?.getAttribute('src'),
      '/api/v1/agent-templates/translator-pro/avatar',
    );
    // 「自定义角色」是默认选中项。
    const custom = screen.getByRole('option', { name: /自定义角色/ });
    assert.equal(custom.getAttribute('aria-selected'), 'true');
    assert.ok(screen.getByText('选择一个角色'));
    assert.ok(nameInput());
    assert.ok(screen.getByText('简介'));
    assert.ok(screen.getByText('头像'));
    assert.ok(screen.getByRole('button', { name: '选择内置头像' }));
    assert.ok(screen.getByRole('button', { name: '上传本地头像' }));
    assert.ok(screen.getByText(/内置头像已优化为 160×160/));
    assert.ok(screen.getByText('本机 test-host（当前设备）· 在线'));
    assert.ok(screen.getByRole('button', { name: '保存并启用' }));
    assert.ok(calls.some((call) => call.url.endsWith('/api/v1/agent-templates')));
  });

  it('supports roving keyboard selection in the role gallery', async () => {
    installApi([]);
    renderDialog();
    const custom = await screen.findByRole('option', { name: /自定义角色/ });
    const template = screen.getByRole('option', { name: /中英翻译助手/ });
    assert.equal(custom.tabIndex, 0);
    assert.equal(template.tabIndex, -1);

    fireEvent.keyDown(custom, { key: 'ArrowRight' });
    assert.equal(template.getAttribute('aria-selected'), 'true');
    assert.equal(template.tabIndex, 0);
    assert.equal(document.activeElement, template);

    fireEvent.keyDown(template, { key: 'ArrowRight' });
    assert.equal(custom.getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, custom);
  });

  it('prefills from the selected template and submits its mark, tagline and body', async () => {
    const calls: Call[] = [];
    installApi(calls);
    const { created } = renderDialog();
    fireEvent.click(await screen.findByRole('option', { name: /中英翻译助手/ }));
    // 名称/简介被预填，仍可编辑；角色设定只读预览。
    assert.equal(nameInput().value, TEMPLATE.name);
    assert.ok(screen.getByDisplayValue(TEMPLATE.description));
    assert.ok(screen.getByText(TEMPLATE.body));
    assert.ok(screen.getByAltText('模板头像预览'));
    assert.ok(screen.getByText('已继承模板头像；可选择内置头像或上传本地头像覆盖。'));
    fireEvent.change(nameInput(), { target: { value: '我的翻译' } });
    submitDialog();
    await waitFor(() => assert.deepEqual(created, ['translator-pro']));
    const create = calls.find((call) => call.url.endsWith('/api/v1/agents') && call.method === 'POST');
    assert.ok(create?.body);
    assert.equal(create.body.id, 'translator-pro');
    assert.equal(create.body.name, '我的翻译');
    assert.equal(create.body.mark, '译');
    assert.equal(create.body.tagline, TEMPLATE.tagline);
    assert.deepEqual(create.body.suggestions, TEMPLATE.suggestions);
    assert.equal(create.body.body, TEMPLATE.body);
    const upload = calls.find((call) => call.url.endsWith('/avatar') && call.method === 'PUT');
    assert.equal(upload?.body?.mimeType, 'image/jpeg');
    assert.ok(
      calls.some((call) => call.url.endsWith('/api/v1/agent-templates/translator-pro/avatar')),
    );
  });

  it('keeps the custom-role path: blank defaults derived from name and description', async () => {
    const calls: Call[] = [];
    installApi(calls);
    const { created } = renderDialog();
    await screen.findByRole('option', { name: /自定义角色/ });
    fireEvent.change(nameInput(), { target: { value: 'Support Triage' } });
    fireEvent.change(screen.getByPlaceholderText(/说明它负责什么/), {
      target: { value: '分流支持工单' },
    });
    submitDialog();
    await waitFor(() => assert.deepEqual(created, ['support-triage']));
    const create = calls.find((call) => call.url.endsWith('/api/v1/agents') && call.method === 'POST');
    assert.ok(create?.body);
    assert.equal(create.body.id, 'support-triage');
    assert.equal(create.body.name, 'Support Triage');
    assert.equal(create.body.mark, 'ST');
    assert.equal(create.body.tagline, '分流支持工单');
    assert.equal(create.body.description, '分流支持工单');
    assert.match(String(create.body.body), /你是 Support Triage/);
  });

  it('validates the avatar client-side and previews a valid pick', async () => {
    installApi([]);
    renderDialog();
    await screen.findByRole('option', { name: /自定义角色/ });
    const input = screen.getByLabelText('选择头像文件');

    const oversized = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', {
      type: 'image/png',
    });
    fireEvent.change(input, { target: { files: [oversized] } });
    assert.ok(await screen.findByText('头像文件不能超过 2 MB'));

    const wrongType = new File(['x'], 'a.gif', { type: 'image/gif' });
    fireEvent.change(input, { target: { files: [wrongType] } });
    assert.ok(await screen.findByText('头像仅支持 PNG / JPG 图片'));

    const valid = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'ok.png', {
      type: 'image/png',
    });
    fireEvent.change(input, { target: { files: [valid] } });
    assert.ok(await screen.findByAltText('头像预览'));
    assert.equal(screen.queryByRole('alert'), null);
  });

  it('creates first, then uploads the chosen avatar', async () => {
    const calls: Call[] = [];
    installApi(calls);
    const { created, avatarErrors } = renderDialog();
    await screen.findByRole('option', { name: /自定义角色/ });
    fireEvent.change(nameInput(), { target: { value: 'Support Triage' } });
    const valid = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'ok.png', {
      type: 'image/png',
    });
    fireEvent.change(screen.getByLabelText('选择头像文件'), { target: { files: [valid] } });
    await screen.findByAltText('头像预览');
    submitDialog();
    await waitFor(() => assert.deepEqual(created, ['support-triage']));
    assert.deepEqual(avatarErrors, []);
    const upload = calls.find((call) => call.url.endsWith('/avatar') && call.method === 'PUT');
    assert.ok(upload);
    assert.equal(upload.url, '/api/v1/agents/support-triage/avatar');
    assert.equal(upload.body?.mimeType, 'image/png');
    assert.equal(typeof upload.body?.dataBase64, 'string');
    // 顺序：先创建，后传头像。
    const createIndex = calls.findIndex(
      (call) => call.url.endsWith('/api/v1/agents') && call.method === 'POST',
    );
    const uploadIndex = calls.findIndex((call) => call.url.endsWith('/avatar'));
    assert.ok(createIndex >= 0 && uploadIndex > createIndex);
  });

  it('paginates the built-in library and uploads the selected optimized avatar', async () => {
    const calls: Call[] = [];
    installApi(calls);
    const { created } = renderDialog();
    await screen.findByRole('option', { name: /自定义角色/ });
    fireEvent.change(nameInput(), { target: { value: 'Avatar Library Bot' } });
    fireEvent.click(screen.getByRole('button', { name: '选择内置头像' }));
    const library = screen.getByRole('listbox', { name: '内置头像' });
    assert.equal(within(library).getAllByRole('option').length, 20);
    assert.ok(screen.getByText('1 / 5'));
    fireEvent.click(within(library).getByRole('option', { name: '头像 001' }));
    assert.ok(await screen.findByAltText('头像预览'));
    submitDialog();
    await waitFor(() => assert.deepEqual(created, ['avatar-library-bot']));
    const upload = calls.find((call) => call.url.endsWith('/avatar') && call.method === 'PUT');
    assert.equal(upload?.body?.mimeType, 'image/jpeg');
    assert.ok(calls.some((call) => call.url.endsWith('/waker-avatar-hq-001.jpg')));
  });

  it('uses roving focus in the avatar library without selecting on arrow keys', async () => {
    const calls: Call[] = [];
    installApi(calls);
    renderDialog();
    await screen.findByRole('option', { name: /自定义角色/ });
    fireEvent.click(screen.getByRole('button', { name: '选择内置头像' }));
    const library = screen.getByRole('listbox', { name: '内置头像' });
    const first = within(library).getByRole('option', { name: '头像 001' });
    const second = within(library).getByRole('option', { name: '头像 002' });
    assert.equal(first.tabIndex, 0);
    assert.equal(second.tabIndex, -1);

    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    assert.equal(document.activeElement, second);
    assert.equal(first.tabIndex, -1);
    assert.equal(second.tabIndex, 0);
    assert.ok(screen.getByRole('listbox', { name: '内置头像' }));
    assert.equal(
      calls.some((call) => call.url.includes('/waker-avatar-hq-002.jpg')),
      false,
    );
  });

  it('keeps the created Waker and reports when the avatar upload fails after create', async () => {
    const calls: Call[] = [];
    installApi(calls, { failAvatar: true });
    const { created, avatarErrors } = renderDialog();
    await screen.findByRole('option', { name: /自定义角色/ });
    fireEvent.change(nameInput(), { target: { value: 'Support Triage' } });
    const valid = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'ok.png', {
      type: 'image/png',
    });
    fireEvent.change(screen.getByLabelText('选择头像文件'), { target: { files: [valid] } });
    await screen.findByAltText('头像预览');
    submitDialog();
    // Agent 保留（onCreated 照常触发），失败通过 onAvatarError 如实上报。
    await waitFor(() => assert.deepEqual(created, ['support-triage']));
    assert.equal(avatarErrors.length, 1);
    assert.match(avatarErrors[0]!, /Waker 已创建，但头像上传失败/);
  });
});
