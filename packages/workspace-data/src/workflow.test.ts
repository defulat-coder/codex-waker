import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeWorkflowDefinition,
  validateWorkflowDefinition,
  WorkflowSpecError,
  type WorkflowReference,
} from './workflow.js';

const completeDefinition = {
  schemaVersion: 1,
  start: 'seed',
  nodes: [
    { id: 'seed', kind: 'action', action: 'set', key: 'topic', value: 'Waker', next: 'draft' },
    {
      id: 'draft',
      kind: 'codex',
      prompt: 'Draft {{topic}}',
      wakerId: 'alpha',
      projectId: 'project-a',
      outputKey: 'draft',
      next: 'route',
    },
    {
      id: 'route',
      kind: 'decision',
      key: 'approved',
      branches: [{ equals: true, next: 'delay' }],
      defaultNext: 'question',
    },
    { id: 'delay', kind: 'wait', durationMs: 1_000, next: 'child' },
    {
      id: 'question',
      kind: 'ask_user',
      prompt: 'Approve?',
      inputKey: 'approved',
      next: 'route_after_question',
    },
    {
      id: 'route_after_question',
      kind: 'decision',
      key: 'approved',
      branches: [{ equals: true, next: 'child' }],
      defaultNext: 'failed',
    },
    {
      id: 'child',
      kind: 'call_workflow',
      workflowId: 'child-flow',
      input: { draft: '{{draft}}' },
      outputKey: 'child',
      next: 'done',
    },
    { id: 'done', kind: 'terminal', status: 'succeeded', output: { ok: true } },
    { id: 'failed', kind: 'terminal', status: 'failed' },
  ],
} as const;

describe('workflow definition', () => {
  it('normalizes every declarative node and resolves owner references', () => {
    const references: WorkflowReference[] = [];
    const definition = normalizeWorkflowDefinition(completeDefinition, {
      resolveReference(reference) {
        references.push(reference);
        return true;
      },
    });
    assert.equal(definition.nodes.length, 9);
    assert.deepEqual(
      references.map(({ kind, id }) => `${kind}:${id}`),
      ['waker:alpha', 'project:project-a', 'workflow:child-flow'],
    );
  });

  it('rejects cycles, missing edges, unreachable nodes and absent terminals', () => {
    for (const [definition, pattern] of [
      [
        {
          schemaVersion: 1,
          start: 'a',
          nodes: [
            { id: 'a', kind: 'action', action: 'set', key: 'x', value: 1, next: 'a' },
            { id: 'orphan', kind: 'terminal', status: 'succeeded' },
          ],
        },
        /cycle|Unreachable/,
      ],
      [
        {
          schemaVersion: 1,
          start: 'a',
          nodes: [{ id: 'a', kind: 'action', action: 'set', key: 'x', value: 1, next: 'gone' }],
        },
        /terminal|missing/,
      ],
    ] as const) {
      assert.throws(() => normalizeWorkflowDefinition(definition), pattern);
    }
  });

  it('rejects unknown parameters, duplicate branches and unsafe context keys', () => {
    const base = {
      schemaVersion: 1,
      start: 'a',
      nodes: [
        { id: 'a', kind: 'action', action: 'set', key: 'safe', value: 1, next: 'done' },
        { id: 'done', kind: 'terminal', status: 'succeeded' },
      ],
    };
    assert.match(
      validateWorkflowDefinition({ ...base, extra: true }).errors.join(' '),
      /unknown fields/,
    );
    assert.match(
      validateWorkflowDefinition({
        ...base,
        nodes: [{ ...base.nodes[0], key: 'state.__proto__.polluted' }, base.nodes[1]],
      }).errors.join(' '),
      /unsafe context key/,
    );
    assert.match(
      validateWorkflowDefinition({
        ...base,
        nodes: [
          {
            id: 'a',
            kind: 'decision',
            key: 'value',
            branches: [
              { equals: 1, next: 'done' },
              { equals: 1, next: 'done' },
            ],
            defaultNext: 'done',
          },
          base.nodes[1],
        ],
      }).errors.join(' '),
      /duplicate matches/,
    );
    assert.throws(
      () =>
        normalizeWorkflowDefinition({
          ...base,
          nodes: [
            {
              ...base.nodes[0],
              value: JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
            },
            base.nodes[1],
          ],
        }),
      WorkflowSpecError,
    );
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.match(validateWorkflowDefinition('x'.repeat(100_001)).errors[0]!, /100000 bytes/);
  });

  it('reports unresolved references without throwing callback details', () => {
    const result = validateWorkflowDefinition(completeDefinition, {
      resolveReference(reference) {
        if (reference.kind === 'project') throw new Error('private detail');
        return reference.kind !== 'workflow';
      },
    });
    assert.equal(result.definition, undefined);
    assert.match(result.errors.join(' '), /Could not validate project project-a/);
    assert.match(result.errors.join(' '), /missing workflow child-flow/);
    assert.doesNotMatch(result.errors.join(' '), /private detail/);
  });
});
