import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '@waker/workspace-data';
import { runDueAutomations } from './scheduler.js';

describe('local automation scheduler', () => {
  it('runs only due enabled automations once', () => {
    let now = 1_000;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    try {
      store.createAutomation({
        id: 'due',
        wakerId: 'waker-one',
        name: 'Due',
        kind: 'schedule',
        schedule: 'once:1500',
        prompt: 'run',
      });
      store.createAutomation({
        id: 'later',
        wakerId: 'waker-one',
        name: 'Later',
        kind: 'schedule',
        schedule: 'once:2500',
        prompt: 'later',
      });
      now = 1_600;
      assert.deepEqual(
        runDueAutomations(store, ['waker-one'], now).tasks.map((task) => task.source),
        ['automation:due'],
      );
      assert.equal(store.getAutomation('waker-one', 'due')?.nextRun, null);
      assert.equal(runDueAutomations(store, ['waker-one'], now).tasks.length, 0);
    } finally {
      store.close();
    }
  });
});
