import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  AgentSessionStore,
  agentSessionStoreFor,
  assertSessionAgentBinding,
  WorkbenchStore,
  workbenchStoreFor,
} from './session-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; store: AgentSessionStore } {
  const root = mkdtempSync(join(tmpdir(), 'codex-session-store-'));
  roots.push(root);
  return { root, store: new AgentSessionStore({ cwd: root }) };
}

/** 手写假 rollout JSONL（Codex CLI 格式按不透明处理，测试只依赖解析器的防御性）。 */
let rolloutWriteCounter = 0;
function writeRollout(sessionDir: string, threadId: string, lines: unknown[]): string {
  const directory = join(sessionDir, '2026', '08', '22');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `rollout-2026-08-22T04-00-00-${threadId}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  // 解析结果按 path+mtimeMs 缓存：显式拨动 mtime，避免同毫秒重写被旧缓存命中。
  rolloutWriteCounter += 1;
  const bumped = new Date(Date.now() + rolloutWriteCounter * 1000);
  utimesSync(file, bumped, bumped);
  return file;
}

const TS = '2026-08-22T04:00:00.000Z';
const userMsg = (text: string) => ({
  timestamp: TS,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const assistantMsg = (text: string) => ({
  timestamp: TS,
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
const reasoningItem = (text: string) => ({
  timestamp: TS,
  type: 'response_item',
  payload: { type: 'reasoning', summary: [{ type: 'summary_text', text }] },
});
const tokenCount = (input: number, output: number, total: number) => ({
  timestamp: TS,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: total },
    },
  },
});
const errorEvent = (message: string) => ({
  timestamp: TS,
  type: 'event_msg',
  payload: { type: 'error', message },
});
const abortedEvent = () => ({
  timestamp: TS,
  type: 'event_msg',
  payload: { type: 'turn_aborted' },
});

describe('agent session store', () => {
  it('creates, lists, renames and deletes bound sessions', async () => {
    const { store } = fixture();
    const created = await store.createSession('codex-assistant', 'session-a');
    assert.equal(created.agentId, 'codex-assistant');
    assert.equal(created.title, '新会话');
    assert.equal(created.questionCount, 0);
    assert.equal(created.read, false);

    const renamed = await store.renameSession('session-a', 'codex-assistant', '架构讨论');
    assert.equal(renamed?.title, '架构讨论');

    const listed = await store.listSessions('codex-assistant');
    assert.deepEqual(
      listed.map((session) => session.id),
      ['session-a'],
    );
    assert.deepEqual(await store.listSessions('other-agent'), []);

    assert.equal(await store.deleteSession('session-a', 'codex-assistant'), true);
    assert.equal(await store.getSession('session-a'), undefined);
  });

  it('counts user messages as questions and derives a title from the first one', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'session-questions');
    await store.bindThread('session-questions', 'codex-assistant', 'thread-questions');
    writeRollout(store.sessionDir, 'thread-questions', [
      userMsg('解释一下会话生命周期'),
      assistantMsg('好的'),
      userMsg('第二个问题'),
      assistantMsg('继续'),
    ]);

    const session = await store.getSession('session-questions');
    assert.equal(session?.questionCount, 2);
    assert.equal(session?.title, '解释一下会话生命周期');
  });

  it('flags sessions whose last assistant message errored or was aborted', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'attention-session');
    await store.bindThread('attention-session', 'codex-assistant', 'thread-attention');
    const file = writeRollout(store.sessionDir, 'thread-attention', [userMsg('你好')]);

    // No assistant message yet: a fresh session never needs attention.
    assert.equal((await store.getSession('attention-session'))?.needsAttention, false);

    writeRollout(store.sessionDir, 'thread-attention', [userMsg('你好'), errorEvent('模型超时')]);
    const errored = await store.getSession('attention-session');
    assert.equal(errored?.needsAttention, true);
    assert.equal(errored?.attentionReason, 'error');
    assert.equal(errored?.attentionDetail, '模型超时');

    writeRollout(store.sessionDir, 'thread-attention', [
      userMsg('你好'),
      assistantMsg('半个回答'),
      abortedEvent(),
    ]);
    const aborted = await store.getSession('attention-session');
    assert.equal(aborted?.needsAttention, true);
    assert.equal(aborted?.attentionReason, 'aborted');

    // A later successful run clears the flag.
    writeRollout(store.sessionDir, 'thread-attention', [
      userMsg('你好'),
      assistantMsg('半个回答'),
      abortedEvent(),
      userMsg('再来'),
      assistantMsg('完整回答'),
    ]);
    assert.equal((await store.getSession('attention-session'))?.needsAttention, false);
    assert.ok(existsSync(file));
  });

  it('replays persisted messages with thinking, usage and error details', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'replay-session');
    await store.bindThread('replay-session', 'codex-assistant', 'thread-replay');
    writeRollout(store.sessionDir, 'thread-replay', [
      { timestamp: TS, type: 'session_meta', payload: { id: 'thread-replay' } },
      userMsg('第一句话'),
      reasoningItem('想一下'),
      assistantMsg('回答你'),
      tokenCount(10, 5, 30),
      userMsg('第二句话'),
      errorEvent('模型超时'),
      'not json at all',
    ]);

    const messages = await store.listMessages('replay-session', 'codex-assistant');
    assert.equal(messages.length, 4);
    assert.equal(messages[0]!.role, 'user');
    assert.equal(messages[0]!.content, '第一句话');
    assert.equal(messages[1]!.thinking, '想一下');
    assert.equal(messages[1]!.content, '回答你');
    assert.deepEqual(messages[1]!.usage, { input: 10, output: 5, total: 30 });
    assert.equal(messages[3]!.role, 'assistant');
    assert.equal(messages[3]!.content, '');
    assert.equal(messages[3]!.stopReason, 'error');
    assert.equal(messages[3]!.errorMessage, '模型超时');

    await assert.rejects(
      () => store.listMessages('replay-session', 'other-agent'),
      /AGENT_SESSION_MISMATCH/,
    );
    await assert.rejects(
      () => store.listMessages('no-such-session', 'codex-assistant'),
      /AGENT_SESSION_NOT_FOUND/,
    );
  });

  it('merges locally recorded turn failures into replay and dedupes rollout error records', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'failure-session');
    await store.bindThread('failure-session', 'codex-assistant', 'thread-failure');
    writeRollout(store.sessionDir, 'thread-failure', [userMsg('第一句话')]);

    // rollout 没有 error 记录的失败（如 provider 401 拒流）：补记按时间序插在 user 之后。
    store.recordTurnFailure('failure-session', 'codex-assistant', {
      timestamp: '2026-08-22T04:01:00.000Z',
      errorMessage: 'HTTP 401 Unauthorized',
      kind: 'auth',
    });
    let messages = await store.listMessages('failure-session', 'codex-assistant');
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant'],
    );
    assert.equal(messages[1]!.stopReason, 'error');
    assert.equal(messages[1]!.errorMessage, 'HTTP 401 Unauthorized');
    assert.equal(messages[1]!.errorKind, 'auth');

    // rollout 落盘了同一条错误：补记被去重，不重复出第二张错误卡。
    writeRollout(store.sessionDir, 'thread-failure', [
      userMsg('第一句话'),
      errorEvent('HTTP 401 Unauthorized'),
    ]);
    messages = await store.listMessages('failure-session', 'codex-assistant');
    assert.equal(
      messages.filter((message) => message.stopReason === 'error').length,
      1,
    );

    // 不同的失败消息是新一轮失败：保留并按时间序排在 rollout 错误之后。
    store.recordTurnFailure('failure-session', 'codex-assistant', {
      timestamp: '2026-08-22T04:02:00.000Z',
      errorMessage: 'quota exceeded，将于 2026-09-01T00:00:00Z 重置',
      kind: 'quota',
      resetAt: '2026-09-01T00:00:00Z',
    });
    messages = await store.listMessages('failure-session', 'codex-assistant');
    const errors = messages.filter((message) => message.stopReason === 'error');
    assert.equal(errors.length, 2);
    assert.deepEqual(
      errors.map((message) => message.errorKind),
      ['auth', 'quota'],
    );
    assert.equal(errors[1]!.errorResetAt, '2026-09-01T00:00:00Z');
  });

  it('overlays sanitized SQLite citation sidecars onto the matching final assistant turn', async () => {
    const { root, store } = fixture();
    await store.createSession('codex-assistant', 'source-session');
    await store.bindThread('source-session', 'codex-assistant', 'thread-sources');
    writeRollout(store.sessionDir, 'thread-sources', [
      userMsg('第一轮'),
      assistantMsg('第一轮回答'),
      userMsg('第二轮'),
      assistantMsg('第二轮中间'),
      assistantMsg('第二轮最终回答'),
    ]);
    const source = {
      index: 1,
      notebookId: 'notes',
      documentId: 'guide',
      documentVersion: 2,
      chunkId: 'guide:2:0',
      title: 'guide.md',
      uri: 'docs/guide.md',
      startLine: 3,
      endLine: 8,
      excerpt: '可追溯的片段',
      matchMode: 'hybrid' as const,
      score: 0.82,
    };
    store.setTurnSources('source-session', 'codex-assistant', 1, [source]);
    store.setTurnSources('source-session', 'codex-assistant', 2, [source]);
    await store.bindThread('source-session', 'codex-assistant', 'thread-temporary');
    await store.bindThread('source-session', 'codex-assistant', 'thread-sources');
    await store.renameSession('source-session', 'codex-assistant', '保留来源');
    await store.updateInboxState('source-session', 'codex-assistant', {
      read: true,
      completed: true,
    });
    assert.equal(store.workbench.listTurnSources('source-session').size, 2);

    // Simulate a tampered/old row: listMessages must apply the trust-boundary sanitizer again.
    const db = new Database(join(root, '.codex', 'workbench.sqlite'));
    db.prepare(
      'UPDATE session_turn_sources SET sources_json = ? WHERE session_id = ? AND turn_index = 1',
    ).run(
      JSON.stringify([
        {
          ...source,
          title: '/Users/private/docs/guide.md',
          uri: 'https://user:secret@docs.example.test/guide.md?token=private#part',
        },
      ]),
      'source-session',
    );
    db.close();

    const messages = await store.listMessages('source-session', 'codex-assistant');
    assert.equal(messages[1]?.sources?.[0]?.title, 'guide.md');
    assert.equal(messages[1]?.sources?.[0]?.uri, 'https://docs.example.test/guide.md');
    assert.equal(messages[3]?.sources, undefined);
    assert.equal(messages[4]?.sources?.[0]?.documentId, 'guide');

    await store.deleteSession('source-session', 'codex-assistant');
    const verify = new Database(join(root, '.codex', 'workbench.sqlite'));
    const count = verify
      .prepare('SELECT COUNT(*) AS count FROM session_turn_sources WHERE session_id = ?')
      .get('source-session') as { count: number };
    verify.close();
    assert.equal(count.count, 0);
  });

  it('derives a single-line preview from the last assistant text, falling back to the user text', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'preview-session');
    assert.equal((await store.getSession('preview-session'))?.preview, undefined);

    await store.bindThread('preview-session', 'codex-assistant', 'thread-preview');
    writeRollout(store.sessionDir, 'thread-preview', [
      userMsg('  多行\n问题   文本 '),
      assistantMsg('第一行\n\n第二行   结束'),
    ]);
    assert.equal((await store.getSession('preview-session'))?.preview, '第一行 第二行 结束');

    // 最后一条 assistant 没有文本（如出错）时退回最后一条 user 文本。
    writeRollout(store.sessionDir, 'thread-preview', [
      userMsg('  多行\n问题   文本 '),
      errorEvent('模型超时'),
    ]);
    assert.equal((await store.getSession('preview-session'))?.preview, '多行 问题 文本');

    // 超长文本截断到 120 字符。
    writeRollout(store.sessionDir, 'thread-preview', [
      userMsg('问题'),
      assistantMsg('长'.repeat(200)),
    ]);
    assert.equal((await store.getSession('preview-session'))?.preview?.length, 120);
  });

  it('rejects cross-agent reuse of a persisted session', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'owned-session');
    await assert.rejects(
      () => store.ensureSession('owned-session', 'other-agent'),
      /AGENT_SESSION_MISMATCH/,
    );
    await assert.rejects(
      () => store.getSession('owned-session', 'other-agent'),
      /AGENT_SESSION_MISMATCH/,
    );
    await assert.rejects(
      () => store.renameSession('owned-session', 'other-agent', '越权'),
      /AGENT_SESSION_MISMATCH/,
    );
    await assert.rejects(
      () => store.deleteSession('owned-session', 'other-agent'),
      /AGENT_SESSION_MISMATCH/,
    );
  });

  it('deleteSession removes the rollout file along with the workbench entry', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'doomed-session');
    await store.bindThread('doomed-session', 'codex-assistant', 'thread-doomed');
    const file = writeRollout(store.sessionDir, 'thread-doomed', [userMsg('再见')]);
    assert.ok(existsSync(file));

    assert.equal(await store.deleteSession('doomed-session', 'codex-assistant'), true);
    assert.equal(existsSync(file), false);
    assert.equal(await store.getSession('doomed-session'), undefined);
  });

  it('rejects sessions without a valid binding instead of migrating them', async () => {
    const { root, store } = fixture();
    // 绕过 store 直接写坏条目：agentId 不合法的绑定不迁移、不展示。
    const workbench = new WorkbenchStore(root);
    workbench.putEntry('invalid-binding', {
      agentId: 'Bad Id',
      threadId: null,
      createdAt: TS,
      updatedAt: TS,
    });
    assert.equal(await store.getSession('invalid-binding'), undefined);
    assert.deepEqual(await store.listSessions(), []);
  });

  it('survives a missing or corrupt legacy workbench.json', async () => {
    const { root, store } = fixture();
    assert.deepEqual(await store.listSessions(), []);
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'workbench.json'), '{ not json');
    assert.deepEqual(await store.listSessions(), []);
    assert.equal(await store.getSession('ghost'), undefined);
  });

  it('migrates a legacy workbench.json into the sqlite database exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-session-store-'));
    roots.push(root);
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'workbench.json'),
      JSON.stringify({
        sessions: {
          'legacy-session': {
            agentId: 'codex-assistant',
            threadId: null,
            createdAt: TS,
            updatedAt: TS,
            read: true,
          },
        },
        preferences: { 'ui.theme': 'dark' },
      }),
    );
    const store = new AgentSessionStore({ cwd: root });
    const migrated = await store.getSession('legacy-session');
    assert.equal(migrated?.agentId, 'codex-assistant');
    assert.equal(migrated?.read, true);
    // 迁移后旧文件改名备份，不会再次导入。
    assert.equal(existsSync(join(root, '.codex', 'workbench.json')), false);
    assert.ok(existsSync(join(root, '.codex', 'workbench.json.bak')));
    assert.equal(new WorkbenchStore(root).getPreferences()['ui.theme'], 'dark');

    // 数据库非空时即使再次出现 workbench.json 也不迁移。
    writeFileSync(
      join(root, '.codex', 'workbench.json'),
      JSON.stringify({
        sessions: {
          'intruder-session': {
            agentId: 'codex-assistant',
            threadId: null,
            createdAt: TS,
            updatedAt: TS,
          },
        },
      }),
    );
    assert.equal(
      await new AgentSessionStore({ cwd: root }).getSession('intruder-session'),
      undefined,
    );
  });

  it('tracks inbox read/completed state on the session entry', async () => {
    const { store } = fixture();
    await store.createSession('codex-assistant', 'inbox-session');
    const updated = await store.updateInboxState('inbox-session', 'codex-assistant', {
      read: true,
      completed: true,
    });
    assert.equal(updated?.read, true);
    assert.ok(updated?.completedAt);

    const cleared = await store.updateInboxState('inbox-session', 'codex-assistant', {
      completed: false,
    });
    assert.equal(cleared?.read, true);
    assert.equal(cleared?.completedAt, undefined);

    await assert.rejects(
      () => store.updateInboxState('inbox-session', 'other-agent', { read: true }),
      /AGENT_SESSION_MISMATCH/,
    );
    await assert.rejects(
      () => store.updateInboxState('ghost-session', 'codex-assistant', { read: true }),
      /AGENT_SESSION_NOT_FOUND/,
    );
  });

  it('validates binding entries explicitly', () => {
    assert.throws(() => assertSessionAgentBinding(undefined), /AGENT_BINDING_MISSING/);
    assert.throws(
      () =>
        assertSessionAgentBinding({
          agentId: 'Bad Id',
          threadId: null,
          createdAt: TS,
          updatedAt: TS,
        }),
      /AGENT_BINDING_INVALID/,
    );
    assert.throws(
      () =>
        assertSessionAgentBinding(
          { agentId: 'codex-assistant', threadId: null, createdAt: TS, updatedAt: TS },
          'other-agent',
        ),
      /AGENT_SESSION_MISMATCH/,
    );
  });

  it('shares stores per cwd through the cached accessors (one sqlite connection per root)', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-session-store-'));
    roots.push(root);
    // 同一 cwd+sessionDir 返回同一实例：连接数不随会话数增长。
    assert.equal(workbenchStoreFor(root), workbenchStoreFor(root));
    assert.equal(agentSessionStoreFor({ cwd: root }), agentSessionStoreFor({ cwd: root }));
    // 直接构造的 AgentSessionStore 也复用同一 WorkbenchStore 缓存。
    assert.equal(new AgentSessionStore({ cwd: root }).workbench, workbenchStoreFor(root));
    // 不同 sessionDir 是不同的共享实例。
    assert.notEqual(
      agentSessionStoreFor({ cwd: root }),
      agentSessionStoreFor({ cwd: root, sessionDir: '.codex/other-sessions' }),
    );
  });

  it('getPreferences skips rows whose JSON value is corrupt', () => {
    const { root } = fixture();
    const workbench = workbenchStoreFor(root);
    workbench.setPreference('ui.theme', 'dark');
    // 绕过 store 直接写一行坏 JSON（store 自己的写入永远是合法 JSON）。
    const db = new Database(join(root, '.codex', 'workbench.sqlite'));
    db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?)').run('ui.broken', '{ not json');
    db.close();
    assert.deepEqual(workbench.getPreferences(), { 'ui.theme': 'dark' });
  });

  it('close() releases the underlying sqlite connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-session-store-'));
    roots.push(root);
    const store = new AgentSessionStore({ cwd: root });
    store.close();
    await assert.rejects(() => store.listSessions());
  });
});
