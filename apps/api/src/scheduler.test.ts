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
      assert.equal(store.listAutomationRuns('waker-one', 'due')[0]?.scheduledFor, 1_500);
      assert.equal(store.getAutomation('waker-one', 'due')?.nextRun, null);
      assert.equal(runDueAutomations(store, ['waker-one'], now).tasks.length, 0);
    } finally {
      store.close();
    }
  });

  it('persists skipped misfires without dispatching a task', () => {
    let now = 1_000;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    try {
      store.createAutomation({
        id: 'skip',
        wakerId: 'waker-one',
        name: 'Skip missed',
        kind: 'schedule',
        schedule: 'interval:1000',
        prompt: 'run',
        misfirePolicy: 'skip',
      });
      now = 62_001;
      const result = runDueAutomations(store, ['waker-one'], now);
      assert.equal(result.tasks.length, 0);
      assert.equal(result.runs[0]?.status, 'skipped');
      assert.equal(result.runs[0]?.scheduledFor, 2_000);
      assert.equal(store.getAutomation('waker-one', 'skip')?.nextRun, 63_000);
    } finally {
      store.close();
    }
  });

  it('does not duplicate a due slot while its first run is active', () => {
    let now = 1_000;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    try {
      store.createAutomation({
        id: 'single',
        wakerId: 'waker-one',
        name: 'Single flight',
        kind: 'schedule',
        schedule: 'interval:500',
        prompt: 'run',
      });
      now = 1_500;
      assert.equal(runDueAutomations(store, ['waker-one'], now).runs.length, 1);
      assert.equal(runDueAutomations(store, ['waker-one'], now).runs.length, 0);
      assert.equal(store.countAutomationRuns('waker-one', 'single'), 1);
    } finally {
      store.close();
    }
  });
});
