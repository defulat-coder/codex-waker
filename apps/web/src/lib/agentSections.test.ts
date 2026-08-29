import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAgentBody, rebuildAgentBody } from './agentSections.js';

const SECTIONED = '前言介绍\n\n## 身份\n负责发散想法。\n\n## 人设\n直接、简洁。\n\n## 设定集\n- 原则一\n- 原则二\n';

describe('parseAgentBody', () => {
  it('按三个约定 H2 切分出三段正文与前言', () => {
    const parsed = parseAgentBody(SECTIONED);
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    assert.deepEqual(parsed.sections, {
      identity: '负责发散想法。',
      persona: '直接、简洁。',
      bible: '- 原则一\n- 原则二',
    });
  });

  it('空段解析为空字符串', () => {
    const parsed = parseAgentBody('## 身份\n甲\n\n## 人设\n\n## 设定集\n丙\n');
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    assert.equal(parsed.sections.persona, '');
  });

  it('缺任一 H2 回退整段模式', () => {
    assert.equal(parseAgentBody('## 身份\n甲\n\n## 人设\n乙\n').mode, 'fallback');
  });

  it('三个 H2 都没有回退整段模式', () => {
    assert.equal(parseAgentBody('只是一段自由文档。\n\n## 其他小节\n内容\n').mode, 'fallback');
  });

  it('约定 H2 重复出现回退整段模式', () => {
    const body = '## 身份\n甲\n\n## 人设\n乙\n\n## 设定集\n丙\n\n## 身份\n丁\n';
    assert.equal(parseAgentBody(body).mode, 'fallback');
  });

  it('段顺序打乱仍按 id 归位', () => {
    const parsed = parseAgentBody('## 设定集\n丙\n\n## 身份\n甲\n\n## 人设\n乙\n');
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    assert.equal(parsed.sections.identity, '甲');
    assert.equal(parsed.sections.bible, '丙');
  });
});

describe('rebuildAgentBody', () => {
  it('不编辑直接拼回等于原文（往返无损）', () => {
    const parsed = parseAgentBody(SECTIONED);
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    assert.equal(rebuildAgentBody(parsed, {}), SECTIONED);
  });

  it('乱序分段同样往返无损', () => {
    const body = '## 设定集\n丙\n\n## 身份\n甲\n\n## 人设\n乙\n';
    const parsed = parseAgentBody(body);
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    assert.equal(rebuildAgentBody(parsed, {}), body);
  });

  it('只替换目标段，前言与其余段逐字节保留', () => {
    const parsed = parseAgentBody(SECTIONED);
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    const next = rebuildAgentBody(parsed, { persona: '新人设内容' });
    assert.equal(
      next,
      '前言介绍\n\n## 身份\n负责发散想法。\n\n## 人设\n新人设内容\n## 设定集\n- 原则一\n- 原则二\n',
    );
  });

  it('编辑内容首尾空白被归一化', () => {
    const parsed = parseAgentBody(SECTIONED);
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    const next = rebuildAgentBody(parsed, { identity: '\n  新身份 \n\n' });
    assert.ok(next.includes('## 身份\n新身份\n'));
  });

  it('清空目标段只保留标题行', () => {
    const parsed = parseAgentBody(SECTIONED);
    assert.equal(parsed.mode, 'sectioned');
    if (parsed.mode !== 'sectioned') return;
    const next = rebuildAgentBody(parsed, { persona: '   ' });
    assert.ok(next.includes('## 人设\n## 设定集\n'));
    // 清空后重新解析仍符合约定，且该段为空。
    const reparsed = parseAgentBody(next);
    assert.equal(reparsed.mode, 'sectioned');
    if (reparsed.mode !== 'sectioned') return;
    assert.equal(reparsed.sections.persona, '');
  });
});
