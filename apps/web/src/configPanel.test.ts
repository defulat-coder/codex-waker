import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OPEN_SECTIONS,
  readThinkingPreference,
  toggleSection,
  writeThinkingPreference,
  type ConfigSectionId,
} from './lib/configPanel.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

describe('toggleSection', () => {
  it('收起已展开的节，展开未展开的节', () => {
    const open: ConfigSectionId[] = [...DEFAULT_OPEN_SECTIONS];
    assert.deepEqual(toggleSection(open, 'basic'), ['resources']);
    assert.deepEqual(toggleSection(open, 'runtime'), ['basic', 'resources', 'runtime']);
  });

  it('不修改原数组', () => {
    const open: ConfigSectionId[] = ['basic'];
    toggleSection(open, 'basic');
    assert.deepEqual(open, ['basic']);
  });
});

describe('thinking preference', () => {
  it('缺省与未知值都回落到 undefined（跟随服务端默认）', () => {
    assert.equal(readThinkingPreference('agent-a', fakeStorage()), undefined);
    assert.equal(
      readThinkingPreference('agent-a', fakeStorage({ 'waker.thinking.agent-a': 'bogus' })),
      undefined,
    );
  });

  it('按 agentId 分别持久化，合法级别原样读回', () => {
    const storage = fakeStorage();
    writeThinkingPreference('agent-a', 'minimal', storage);
    assert.equal(readThinkingPreference('agent-a', storage), 'minimal');
    writeThinkingPreference('agent-a', 'high', storage);
    assert.equal(readThinkingPreference('agent-a', storage), 'high');
    assert.equal(readThinkingPreference('agent-b', storage), undefined);
    writeThinkingPreference('agent-a', undefined, storage);
    assert.equal(readThinkingPreference('agent-a', storage), undefined);
  });

  it('storage 不可用时读 undefined、写不抛错', () => {
    assert.equal(readThinkingPreference('agent-a', undefined), undefined);
    assert.doesNotThrow(() => writeThinkingPreference('agent-a', 'minimal', undefined));
  });

  it('storage 抛错时静默降级', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    assert.equal(readThinkingPreference('agent-a', throwing), undefined);
    assert.doesNotThrow(() => writeThinkingPreference('agent-a', 'minimal', throwing));
  });
});
