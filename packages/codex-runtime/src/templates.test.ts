import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TEMPLATES } from './templates.js';

describe('agent templates', () => {
  it('ships unique valid ids for every built-in template', () => {
    const ids = AGENT_TEMPLATES.map((template) => template.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]{1,63}$/);
    for (const template of AGENT_TEMPLATES) {
      assert.ok(template.body.trim().length > 0);
      assert.ok(template.suggestions.length > 0);
    }
  });
});
