import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurnError } from './error-classification.js';

describe('classifyTurnError', () => {
  const cases: Array<{
    name: string;
    input: { code?: string; message: string };
    kind: string;
    resetAt?: string;
  }> = [
    // quota：专用错误串 / quota 关键字 / 旧版配额错误码
    {
      name: 'quota.exceeded 命中 quota',
      input: { code: 'CODEX_TURN_FAILED', message: 'provider error: quota.exceeded' },
      kind: 'quota',
    },
    {
      name: 'quota 关键字命中 quota',
      input: { message: 'Your usage quota has been exhausted' },
      kind: 'quota',
    },
    {
      name: '配额错误码 110 命中 quota',
      input: { message: '请求失败，错误码 110' },
      kind: 'quota',
    },
    {
      name: '配额错误码 117 命中 quota',
      input: { message: 'upstream rejected with code 117' },
      kind: 'quota',
    },
    {
      name: 'quota 消息带重置时间时提取 resetAt',
      input: { message: 'quota exceeded，将于 2026-09-01T00:00:00Z 重置' },
      kind: 'quota',
      resetAt: '2026-09-01T00:00:00Z',
    },
    // rate_limit：关键字 / 429 / 10605
    {
      name: 'rate limit 关键字命中 rate_limit',
      input: { message: 'Rate limit exceeded, please slow down' },
      kind: 'rate_limit',
    },
    { name: 'HTTP 429 命中 rate_limit', input: { message: 'HTTP 429 too many requests' }, kind: 'rate_limit' },
    { name: '错误码 10605 命中 rate_limit', input: { message: '服务限流，code 10605' }, kind: 'rate_limit' },
    // auth：unauthorized / 401 / auth expired / login / 10401
    {
      name: '401 Unauthorized 命中 auth',
      input: { message: 'HTTP 401 Unauthorized' },
      kind: 'auth',
    },
    {
      name: 'auth expired 命中 auth',
      input: { message: 'auth expired, please login again' },
      kind: 'auth',
    },
    { name: '错误码 10401 命中 auth', input: { message: '认证失败，错误码 10401' }, kind: 'auth' },
    {
      name: '10401 不被误判为 401 之外的类别',
      input: { message: 'status 10401' },
      kind: 'auth',
    },
    // timeout：timeout / timed out / 408
    {
      name: 'timeout 关键字命中 timeout',
      input: { message: 'Request timeout after 30s' },
      kind: 'timeout',
    },
    { name: 'timed out 命中 timeout', input: { message: 'connection timed out' }, kind: 'timeout' },
    { name: 'HTTP 408 命中 timeout', input: { message: 'HTTP 408 request timeout' }, kind: 'timeout' },
    // network：unable to connect / ECONN* / fetch failed / network / socket
    {
      name: 'unable to connect 命中 network',
      input: { message: 'Unable to connect to the model service' },
      kind: 'network',
    },
    { name: 'ECONNREFUSED 命中 network', input: { message: 'connect ECONNREFUSED 127.0.0.1:443' }, kind: 'network' },
    { name: 'ECONNRESET 命中 network', input: { message: 'read ECONNRESET' }, kind: 'network' },
    { name: 'fetch failed 命中 network', input: { message: 'TypeError: fetch failed' }, kind: 'network' },
    { name: 'network 关键字命中 network', input: { message: 'network error occurred' }, kind: 'network' },
    { name: 'socket 关键字命中 network', input: { message: 'socket hang up' }, kind: 'network' },
    // startup：启动失败错误码优先于消息关键字
    {
      name: '启动失败错误码命中 startup',
      input: { code: 'CODEX_RUN_STREAM_START_FAILED', message: 'stream failed: fetch failed' },
      kind: 'startup',
    },
    // 兜底
    { name: '无特征消息兜底 generic', input: { message: 'something went wrong' }, kind: 'generic' },
    { name: '空消息兜底 generic', input: { message: '' }, kind: 'generic' },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = classifyTurnError(testCase.input);
      assert.equal(result.kind, testCase.kind);
      assert.equal(result.resetAt, testCase.resetAt);
    });
  }

  it('数字错误码按独立 token 匹配：1105 不命中配额码 110', () => {
    assert.equal(classifyTurnError({ message: 'upstream code 1105' }).kind, 'generic');
  });

  it('分类优先级：quota 先于 rate_limit，rate_limit 先于 auth', () => {
    assert.equal(
      classifyTurnError({ message: 'quota exhausted with HTTP 429' }).kind,
      'quota',
    );
    assert.equal(
      classifyTurnError({ message: 'rate limit reached, login required' }).kind,
      'rate_limit',
    );
  });
});
