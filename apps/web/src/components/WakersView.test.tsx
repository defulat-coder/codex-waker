import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentDeleteImpact, AgentSummary } from '@waker/contracts';
import { WakersView } from './LegacyWorkbench.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const agents: AgentSummary[] = [
  {
    id: 'agent-a',
    name: 'Agent A',
    mark: 'AA',
    tagline: 'A',
    description: 'A',
    suggestions: [],
  },
  {
    id: 'agent-b',
    name: 'Agent B',
    mark: 'BB',
    tagline: 'B',
    description: 'B',
    suggestions: [],
  },
];

function impact(agentId: string, sessions: number): AgentDeleteImpact {
  return {
    agentId,
    sessions,
    projects: 0,
    automations: 0,
    workflows: 0,
    tasks: 0,
    humanActions: 0,
    connectors: 0,
    sharedSkills: 1,
    behavior: {
      definition: 'delete',
      sessions: 'delete',
      projects: 'delete-record-only',
      board: 'soft-delete-history',
      connectors: 'delete',
      skills: 'shared-preserve',
    },
  };
}

describe('WakersView delete impact', () => {
  it('discards a late impact response from a previously selected Waker', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    globalThis.fetch = (async (input) =>
      String(input).includes('agent-a') ? a.promise : b.promise) as typeof fetch;
    render(
      <WakersView
        agents={agents}
        onChat={() => {}}
        onConfigure={() => {}}
        onMemory={() => {}}
        onCapabilities={() => {}}
        onAutomation={() => {}}
        onCreated={() => {}}
        onDeleted={() => {}}
        notify={() => {}}
      />,
    );

    const cardA = screen.getByRole('heading', { name: 'Agent A' }).closest('article')!;
    fireEvent.click(within(cardA).getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const cardB = screen.getByRole('heading', { name: 'Agent B' }).closest('article')!;
    fireEvent.click(within(cardB).getByRole('button', { name: '删除' }));

    await act(async () => {
      a.resolve(Response.json(impact('agent-a', 99)));
      await Promise.resolve();
    });
    const dialog = screen.getByRole('dialog', { name: '删除 Agent B' });
    assert.match(dialog.textContent ?? '', /正在检查/);
    assert.doesNotMatch(dialog.textContent ?? '', /99 个会话/);

    await act(async () => {
      b.resolve(Response.json(impact('agent-b', 2)));
      await Promise.resolve();
    });
    assert.match(dialog.textContent ?? '', /2 个会话/);
  });
});
