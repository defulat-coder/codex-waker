import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMessage } from '@waker/contracts';
import { buildInboxResumeText, INBOX_CONTINUE_TEXT } from './inboxResume.js';

const at = (id: number, role: SessionMessage['role'], content: string): SessionMessage => ({
  id: `m${id}`,
  role,
  content,
  timestamp: `2026-08-21T08:00:0${id}.000Z`,
});

describe('buildInboxResumeText', () => {
  it('retry：取最后一条用户消息的内容', () => {
    const messages = [
      at(1, 'user', '第一个问题'),
      at(2, 'assistant', '半截回答'),
      at(3, 'user', '第二个问题'),
      at(4, 'assistant', ''),
    ];
    assert.equal(buildInboxResumeText(messages, 'retry'), '第二个问题');
  });

  it('retry：会话里没有用户消息时返回 null', () => {
    assert.equal(buildInboxResumeText([], 'retry'), null);
    assert.equal(buildInboxResumeText([at(1, 'assistant', '只有回答')], 'retry'), null);
  });

  it('continue：固定「请继续」，与消息内容无关', () => {
    assert.equal(INBOX_CONTINUE_TEXT, '请继续');
    assert.equal(buildInboxResumeText([], 'continue'), '请继续');
    assert.equal(buildInboxResumeText([at(1, 'user', '问题')], 'continue'), '请继续');
  });
});
