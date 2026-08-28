import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cx } from './cx.js';

describe('cx', () => {
  it('拼接有效片段并跳过 falsy 值', () => {
    assert.equal(cx('a', false, 'b', null, undefined, 'c'), 'a b c');
  });

  it('全部为空时返回空字符串', () => {
    assert.equal(cx(false, undefined), '');
  });
});
