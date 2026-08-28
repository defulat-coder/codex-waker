import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeHtmlEntities,
  parseCompactCount,
  parseSkillsShDetail,
  parseSkillsShSearch,
  parseSkillsShTop,
} from './skills-sh.js';

// 真实 skills.sh 首页的两个榜单行（svg 内部已掏空，结构原样保留）。
// 测试从包根目录运行（dist/**/*.test.js），fixture 留在 src 下，不走 tsc 产物。
const fixture = readFileSync(join(process.cwd(), 'src', 'lib', 'skills-sh.fixture.html'), 'utf8');
// 真实 skills.sh 详情页的 og 元信息 + h1 + Installs 侧栏（svg 掏空）。
const detailFixture = readFileSync(
  join(process.cwd(), 'src', 'lib', 'skills-sh-detail.fixture.html'),
  'utf8',
);

describe('parseCompactCount', () => {
  it('parses compact install strings', () => {
    assert.equal(parseCompactCount('3.1M'), 3_100_000);
    assert.equal(parseCompactCount('653K'), 653_000);
    assert.equal(parseCompactCount('1,234'), 1234);
    assert.equal(parseCompactCount('42'), 42);
    assert.equal(parseCompactCount('n/a'), undefined);
    assert.equal(parseCompactCount(''), undefined);
  });
});

describe('parseSkillsShTop', () => {
  it('parses the real homepage rows with rank, source, installs and weekly sparkline', () => {
    const items = parseSkillsShTop(fixture);
    assert.equal(items.length, 2);
    const first = items[0]!;
    assert.equal(first.id, 'vercel-labs/skills/find-skills');
    assert.equal(first.name, 'find-skills');
    assert.equal(first.source, 'vercel-labs/skills');
    assert.equal(first.rank, 1);
    assert.equal(first.installs, 3_100_000);
    assert.deepEqual(
      first.weeklyInstalls,
      [113_781, 109_199, 109_085, 115_475, 107_969, 101_120, 96_861, 93_130],
    );
    assert.equal(items[1]!.rank, 2);
    assert.equal(items[1]!.source, 'mattpocock/skills');
  });

  it('skips non-list links and dedupes by id', () => {
    const stray = '<a class="x" href="/foo/bar/baz"><span>not a list row</span></a>';
    const items = parseSkillsShTop(`${fixture}${stray}${fixture}`);
    assert.equal(items.length, 2);
  });

  it('returns an empty list for unrelated HTML', () => {
    assert.deepEqual(parseSkillsShTop('<html><body>oops</body></html>'), []);
  });
});

describe('parseSkillsShSearch', () => {
  it('maps search hits, defaulting missing name/installs', () => {
    const items = parseSkillsShSearch({
      skills: [
        {
          id: 'vercel-labs/skills/find-skills',
          skillId: 'find-skills',
          name: 'Find Skills',
          installs: 123,
          source: 'vercel-labs/skills',
        },
        { id: 'mattpocock/skills/tdd', skillId: 'tdd', source: 'mattpocock/skills' },
        { bogus: true },
      ],
    });
    assert.deepEqual(items, [
      {
        id: 'vercel-labs/skills/find-skills',
        name: 'Find Skills',
        source: 'vercel-labs/skills',
        installs: 123,
      },
      { id: 'mattpocock/skills/tdd', name: 'tdd', source: 'mattpocock/skills', installs: 0 },
    ]);
  });

  it('returns an empty list for malformed bodies', () => {
    assert.deepEqual(parseSkillsShSearch(null), []);
    assert.deepEqual(parseSkillsShSearch({ skills: 'nope' }), []);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones', () => {
    assert.equal(
      decodeHtmlEntities('&quot;a&quot; &amp; &lt;b&gt; &#39;c&#39; &#x2014;'),
      '"a" & <b> \'c\' —',
    );
    assert.equal(decodeHtmlEntities('&notanentity; 纯文本'), '&notanentity; 纯文本');
  });
});

describe('parseSkillsShDetail', () => {
  it('parses the real detail page: og:description decoded, h1 name, sidebar installs', () => {
    const detail = parseSkillsShDetail(detailFixture);
    assert.equal(detail.name, 'find-skills');
    assert.equal(
      detail.description,
      'Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express…',
    );
    assert.equal(detail.installs, 3_100_000);
  });

  it('falls back to the og:title prefix for the name and tolerates missing fields', () => {
    const detail = parseSkillsShDetail(
      '<html><head><meta property="og:title" content="tdd — mattpocock/skills"/></head><body></body></html>',
    );
    assert.deepEqual(detail, { name: 'tdd' });
    assert.deepEqual(parseSkillsShDetail('<html><body>oops</body></html>'), {});
  });
});
