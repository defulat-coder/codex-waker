import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InstalledSkillSummary, LibrarySkillSummary } from '@waker/contracts';
import { SkillsView } from './SkillsView.js';

const originalFetch = globalThis.fetch;
const INSTALLED: InstalledSkillSummary = {
  locator: 'agents:owner/repo:review-skill',
  name: 'review-skill',
  description: 'Review changes safely',
  version: '1.2.0',
  source: 'owner/repo',
  scope: 'agents',
  path: '.agents/skills/review-skill/SKILL.md',
  availability: 'available',
  managed: true,
  valid: true,
  errors: [],
  allowImplicitInvocation: false,
  dependencies: [{ type: 'tool', value: 'git' }],
  files: [{ path: 'SKILL.md', size: 120, executable: false, symlink: false }],
  lock: { version: 1, computedHash: 'abc123' },
  integrity: 'ok',
};
const LEGACY: InstalledSkillSummary = {
  ...INSTALLED,
  locator: 'codex:.codex/skills/legacy-skill/SKILL.md',
  name: 'legacy-skill',
  description: 'Legacy host-only source',
  scope: 'codex',
  path: '.codex/skills/legacy-skill/SKILL.md',
  availability: 'available',
  managed: false,
  integrity: 'unmanaged',
};
const LIBRARY: LibrarySkillSummary = {
  id: 'owner/repo/third-skill',
  name: 'third-skill',
  source: 'owner/repo',
  installs: 1200,
  installed: false,
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
type Call = { url: string; method: string; body?: Record<string, unknown> };
function installApi(calls: Call[]) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/skills/installed')) return json({ items: [INSTALLED, LEGACY], total: 2 });
    if (url.includes('/skills/installed/content'))
      return json({ ...INSTALLED, content: '# Instructions\nBe careful.' });
    if (url.includes('/skills/library?')) return json({ items: [LIBRARY], total: 1, mode: 'top' });
    if (url.includes('/skills/library/detail'))
      return json({
        ...LIBRARY,
        thirdParty: true,
        contentReviewed: false,
        riskNotice: 'Third-party content is not reviewed.',
      });
    if (url.endsWith('/skills/install')) return json({ items: [INSTALLED], total: 1 });
    if (url.endsWith('/skills/remove')) return json({ items: [], total: 0 });
    if (url.endsWith('/skills/upload')) return json(INSTALLED, 201);
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SkillsView', () => {
  it('filters runtime, invalid and legacy inventory without claiming Waker bindings', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<SkillsView />);
    await screen.findByRole('button', { name: /review-skill/ });
    fireEvent.change(screen.getByLabelText('筛选已安装 Skills'), {
      target: { value: 'host' },
    });
    assert.equal(screen.queryByRole('button', { name: /review-skill/ }), null);
    assert.ok(screen.getByRole('button', { name: /legacy-skill/ }));
  });

  it('exposes workspace scope, APG tabs, stable locator detail and restores card focus', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<SkillsView />);
    assert.ok(screen.getByText(/工作区共享，不是 per-Waker/));
    const installedTab = screen.getByRole('tab', { name: '我的技能' });
    const libraryTab = screen.getByRole('tab', { name: '第三方发现源' });
    assert.equal(installedTab.tabIndex, 0);
    assert.equal(libraryTab.tabIndex, -1);
    const card = await screen.findByRole('button', { name: /review-skill/ });
    fireEvent.click(card);
    await waitFor(() => assert.ok(document.activeElement?.classList.contains('skills-dock')));
    assert.match(
      calls.find((call) => call.url.includes('/installed/content'))?.url ?? '',
      /locator=agents/,
    );
    assert.ok(await screen.findByText('abc123'));
    assert.ok(screen.getByText('tool:git'));
    assert.ok(screen.getByText('SKILL.md'));
    fireEvent.click(screen.getByRole('button', { name: '关闭技能详情' }));
    await waitFor(() => assert.ok(document.activeElement === card));
    installedTab.focus();
    fireEvent.keyDown(installedTab, { key: 'ArrowRight' });
    assert.ok(document.activeElement === libraryTab);
    assert.equal(libraryTab.getAttribute('aria-controls'), screen.getByRole('tabpanel').id);
  });

  it('requires a protected third-party risk confirmation before install', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<SkillsView />);
    fireEvent.click(screen.getByRole('tab', { name: '第三方发现源' }));
    const card = await screen.findByRole('button', { name: /third-skill/ });
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));
    assert.equal(
      calls.some((call) => call.url.endsWith('/skills/install')),
      false,
    );
    const dialog = screen.getByRole('dialog', { name: '安装第三方 Skill？' });
    assert.ok(within(dialog).getByText(/not reviewed/));
    fireEvent.click(within(dialog).getByRole('button', { name: '确认安装' }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/skills/install'))));
  });

  it('parses upload name from frontmatter and removes by locator with scope disclosure', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<SkillsView />);
    const file = new File(
      ['---\nname: uploaded-skill\ndescription: Uploaded instructions\n---\nDo work.'],
      'SKILL.md',
      { type: 'text/markdown' },
    );
    fireEvent.change(screen.getByTestId('skill-upload-input'), { target: { files: [file] } });
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/skills/upload'))));
    assert.equal(
      calls.find((call) => call.url.endsWith('/skills/upload'))?.body?.name,
      'uploaded-skill',
    );
    const card = await screen.findByRole('button', { name: /review-skill/ });
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: `删除“${INSTALLED.name}”？` });
    assert.ok(within(dialog).getByText(/skills-lock.json/));
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/skills/remove'))));
    assert.equal(
      calls.find((call) => call.url.endsWith('/skills/remove'))?.body?.locator,
      INSTALLED.locator,
    );
  });
});
