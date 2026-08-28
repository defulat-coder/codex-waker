export type WorkflowJsonValue =
  null | boolean | number | string | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };

export type WorkflowScalar = null | boolean | number | string;
export type WorkflowThinkingLevel =
  'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

interface WorkflowNodeBase {
  id: string;
  name?: string;
}

export interface WorkflowActionNode extends WorkflowNodeBase {
  kind: 'action';
  action: 'set';
  key: string;
  value: WorkflowJsonValue;
  next: string;
}

export interface WorkflowCodexNode extends WorkflowNodeBase {
  kind: 'codex';
  prompt: string;
  wakerId?: string;
  projectId?: string;
  model?: string;
  thinking?: WorkflowThinkingLevel;
  outputKey?: string;
  next: string;
}

export interface WorkflowDecisionBranch {
  equals: WorkflowScalar;
  next: string;
}

export interface WorkflowDecisionNode extends WorkflowNodeBase {
  kind: 'decision';
  key: string;
  branches: WorkflowDecisionBranch[];
  defaultNext: string;
}

export interface WorkflowWaitNode extends WorkflowNodeBase {
  kind: 'wait';
  durationMs: number;
  next: string;
}

export interface WorkflowAskUserNode extends WorkflowNodeBase {
  kind: 'ask_user';
  prompt: string;
  inputKey: string;
  next: string;
}

export interface WorkflowCallNode extends WorkflowNodeBase {
  kind: 'call_workflow';
  workflowId: string;
  input?: WorkflowJsonValue;
  outputKey?: string;
  next: string;
}

export interface WorkflowTerminalNode extends WorkflowNodeBase {
  kind: 'terminal';
  status: 'succeeded' | 'failed';
  output?: WorkflowJsonValue;
}

export type WorkflowNode =
  | WorkflowActionNode
  | WorkflowCodexNode
  | WorkflowDecisionNode
  | WorkflowWaitNode
  | WorkflowAskUserNode
  | WorkflowCallNode
  | WorkflowTerminalNode;

export interface WorkflowDefinition {
  schemaVersion: 1;
  start: string;
  nodes: WorkflowNode[];
}

export interface WorkflowReference {
  kind: 'waker' | 'project' | 'workflow';
  id: string;
  nodeId?: string;
}

export interface WorkflowDefinitionOptions {
  resolveReference?: (reference: WorkflowReference) => boolean;
}

export interface WorkflowValidationResult {
  definition?: WorkflowDefinition;
  errors: string[];
}

export class WorkflowSpecError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('; '));
    this.name = 'WorkflowSpecError';
    this.errors = errors;
  }
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const keyPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/;
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const maxNodes = 100;
const maxDefinitionBytes = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${path} has unknown fields: ${extra.join(', ')}`);
}

function text(value: unknown, path: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} is required`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${path} exceeds ${max} characters`);
  return result;
}

function optionalText(value: unknown, path: string, max = 240): string | undefined {
  return value === undefined ? undefined : text(value, path, max);
}

function id(value: unknown, path: string): string {
  const result = text(value, path, 80);
  if (!idPattern.test(result)) throw new Error(`${path} has an invalid identifier`);
  return result;
}

function key(value: unknown, path: string): string {
  const result = text(value, path, 120);
  if (!keyPattern.test(result)) throw new Error(`${path} has an invalid context key`);
  if (result.split(/[.-]/).some((segment) => unsafeKeys.has(segment))) {
    throw new Error(`${path} contains an unsafe context key`);
  }
  return result;
}

function jsonValue(value: unknown, path: string, depth = 0): WorkflowJsonValue {
  if (depth > 12) throw new Error(`${path} exceeds the maximum nesting depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error(`${path} has too many items`);
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) throw new Error(`${path} must be JSON-compatible`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain JSON object`);
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new Error(`${path} must not contain symbol keys`);
  }
  if (Object.keys(value).length > 1_000) throw new Error(`${path} has too many fields`);
  const unsafe = Object.keys(value).find((entry) => unsafeKeys.has(entry));
  if (unsafe) throw new Error(`${path}.${unsafe} is not allowed`);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((entry) => [entry, jsonValue(value[entry], `${path}.${entry}`, depth + 1)]),
  );
}

function scalar(value: unknown, path: string): WorkflowScalar {
  const normalized = jsonValue(value, path);
  if (Array.isArray(normalized) || (normalized !== null && typeof normalized === 'object')) {
    throw new Error(`${path} must be a scalar JSON value`);
  }
  return normalized;
}

function baseNode(
  value: Record<string, unknown>,
  index: number,
): { id: string; name?: string; path: string } {
  const path = `nodes[${index}]`;
  const name = optionalText(value.name, `${path}.name`);
  return { id: id(value.id, `${path}.id`), ...(name ? { name } : {}), path };
}

function normalizeNode(value: unknown, index: number): WorkflowNode {
  if (!isRecord(value)) throw new Error(`nodes[${index}] must be an object`);
  const base = baseNode(value, index);
  switch (value.kind) {
    case 'action': {
      exactKeys(value, ['id', 'name', 'kind', 'action', 'key', 'value', 'next'], base.path);
      if (value.action !== 'set') throw new Error(`${base.path}.action must be set`);
      return {
        id: base.id,
        ...(base.name ? { name: base.name } : {}),
        kind: 'action',
        action: 'set',
        key: key(value.key, `${base.path}.key`),
        value: jsonValue(value.value ?? null, `${base.path}.value`),
        next: id(value.next, `${base.path}.next`),
      };
    }
    case 'codex': {
      exactKeys(
        value,
        [
          'id',
          'name',
          'kind',
          'prompt',
          'wakerId',
          'projectId',
          'model',
          'thinking',
          'outputKey',
          'next',
        ],
        base.path,
      );
      if (
        value.thinking !== undefined &&
        !thinkingLevels.includes(value.thinking as WorkflowThinkingLevel)
      ) {
        throw new Error(`${base.path}.thinking is invalid`);
      }
      const wakerId = optionalText(value.wakerId, `${base.path}.wakerId`, 160);
      const projectId = optionalText(value.projectId, `${base.path}.projectId`, 160);
      const model = optionalText(value.model, `${base.path}.model`, 160);
      const outputKey =
        value.outputKey === undefined ? undefined : key(value.outputKey, `${base.path}.outputKey`);
      return {
        id: base.id,
        ...(base.name ? { name: base.name } : {}),
        kind: 'codex',
        prompt: text(value.prompt, `${base.path}.prompt`),
        ...(wakerId ? { wakerId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(model ? { model } : {}),
        ...(value.thinking ? { thinking: value.thinking as WorkflowThinkingLevel } : {}),
        ...(outputKey ? { outputKey } : {}),
        next: id(value.next, `${base.path}.next`),
      };
    }
    case 'decision': {
      exactKeys(value, ['id', 'name', 'kind', 'key', 'branches', 'defaultNext'], base.path);
      if (!Array.isArray(value.branches) || value.branches.length === 0) {
        throw new Error(`${base.path}.branches must not be empty`);
      }
      if (value.branches.length > 50) throw new Error(`${base.path}.branches has too many items`);
      const branches = value.branches.map((branch, branchIndex) => {
        const path = `${base.path}.branches[${branchIndex}]`;
        if (!isRecord(branch)) throw new Error(`${path} must be an object`);
        exactKeys(branch, ['equals', 'next'], path);
        return {
          equals: scalar(branch.equals, `${path}.equals`),
          next: id(branch.next, `${path}.next`),
        };
      });
      const distinct = new Set(branches.map((branch) => JSON.stringify(branch.equals)));
      if (distinct.size !== branches.length)
        throw new Error(`${base.path}.branches contains duplicate matches`);
      return {
        id: base.id,
        ...(base.name ? { name: base.name } : {}),
        kind: 'decision',
        key: key(value.key, `${base.path}.key`),
        branches,
        defaultNext: id(value.defaultNext, `${base.path}.defaultNext`),
      };
    }
    case 'wait': {
      exactKeys(value, ['id', 'name', 'kind', 'durationMs', 'next'], base.path);
      if (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 1) {
        throw new Error(`${base.path}.durationMs must be a positive integer`);
      }
      if ((value.durationMs as number) > 2_592_000_000) {
        throw new Error(`${base.path}.durationMs exceeds 30 days`);
      }
      return {
        id: base.id,
        ...(base.name ? { name: base.name } : {}),
        kind: 'wait',
        durationMs: value.durationMs as number,
        next: id(value.next, `${base.path}.next`),
      };
    }
    case 'ask_user': {
      exactKeys(value, ['id', 'name', 'kind', 'prompt', 'inputKey', 'next'], base.path);
      return {
        id: base.id,
        ...(base.name ? { name: base.name } : {}),
        kind: 'ask_user',
        prompt: text(value.prompt, `${base.path}.prompt`, 4_000),
        inputKey: key(value.inputKey, `${base.path}.inputKey`),
        next: id(value.next, `${base.path}.next`),
      };
    }
    case 'call_workflow': {
      exactKeys(
        value,
        ['id', 'name', 'kind', 'workflowId', 'input', 'outputKey', 'next'],
        base.path,
      );
      const outputKey =
        value.outputKey === undefined ? undefined : key(value.outputKey, `${base.path}.outputKey`);
      return {
        id: base.id,
        ...(base.name ? { name: base.name } : {}),
        kind: 'call_workflow',
        workflowId: text(value.workflowId, `${base.path}.workflowId`, 160),
        ...(value.input === undefined
          ? {}
          : { input: jsonValue(value.input, `${base.path}.input`) }),
        ...(outputKey ? { outputKey } : {}),
        next: id(value.next, `${base.path}.next`),
      };
    }
    case 'terminal': {
      exactKeys(value, ['id', 'name', 'kind', 'status', 'output'], base.path);
      if (value.status !== 'succeeded' && value.status !== 'failed') {
        throw new Error(`${base.path}.status must be succeeded or failed`);
      }
      return {
        id: base.id,
        ...(base.name ? { name: base.name } : {}),
        kind: 'terminal',
        status: value.status,
        ...(value.output === undefined
          ? {}
          : { output: jsonValue(value.output, `${base.path}.output`) }),
      };
    }
    default:
      throw new Error(`${base.path}.kind is invalid`);
  }
}

function edges(node: WorkflowNode): string[] {
  if (node.kind === 'terminal') return [];
  if (node.kind === 'decision') {
    return [...node.branches.map((branch) => branch.next), node.defaultNext];
  }
  return [node.next];
}

function validateGraph(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const nodes = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodes.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    else nodes.set(node.id, node);
  }
  if (!nodes.has(definition.start)) errors.push(`Start node does not exist: ${definition.start}`);
  if (!definition.nodes.some((node) => node.kind === 'terminal')) {
    errors.push('Workflow must contain a terminal node');
  }
  for (const node of definition.nodes) {
    for (const target of edges(node)) {
      if (!nodes.has(target)) errors.push(`Node ${node.id} points to missing node ${target}`);
    }
  }
  if (errors.length || !nodes.has(definition.start)) return errors;

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reachable = new Set<string>();
  const visit = (nodeId: string): void => {
    reachable.add(nodeId);
    if (visiting.has(nodeId)) {
      errors.push(`Workflow contains a cycle at node ${nodeId}`);
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const target of edges(nodes.get(nodeId)!)) visit(target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(definition.start);
  const unreachable = definition.nodes
    .filter((node) => !reachable.has(node.id))
    .map((node) => node.id);
  if (unreachable.length) errors.push(`Unreachable nodes: ${unreachable.join(', ')}`);
  return [...new Set(errors)];
}

function validateReferences(
  definition: WorkflowDefinition,
  resolveReference?: WorkflowDefinitionOptions['resolveReference'],
): string[] {
  if (!resolveReference) return [];
  const errors: string[] = [];
  for (const node of definition.nodes) {
    const references: WorkflowReference[] = [];
    if (node.kind === 'codex') {
      if (node.wakerId) references.push({ kind: 'waker', id: node.wakerId, nodeId: node.id });
      if (node.projectId) references.push({ kind: 'project', id: node.projectId, nodeId: node.id });
    } else if (node.kind === 'call_workflow') {
      references.push({ kind: 'workflow', id: node.workflowId, nodeId: node.id });
    }
    for (const reference of references) {
      try {
        if (!resolveReference(reference)) {
          errors.push(`Node ${node.id} references missing ${reference.kind} ${reference.id}`);
        }
      } catch {
        errors.push(`Could not validate ${reference.kind} ${reference.id} for node ${node.id}`);
      }
    }
  }
  return errors;
}

export function validateWorkflowDefinition(
  input: unknown,
  options: WorkflowDefinitionOptions = {},
): WorkflowValidationResult {
  try {
    if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > maxDefinitionBytes) {
      throw new Error(`Workflow definition exceeds ${maxDefinitionBytes} bytes`);
    }
    const source = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
    if (!isRecord(source)) throw new Error('Workflow definition must be an object');
    exactKeys(source, ['schemaVersion', 'start', 'nodes'], 'definition');
    if (source.schemaVersion !== 1) throw new Error('definition.schemaVersion must be 1');
    if (!Array.isArray(source.nodes) || source.nodes.length === 0) {
      throw new Error('definition.nodes must not be empty');
    }
    if (source.nodes.length > maxNodes) throw new Error(`definition.nodes exceeds ${maxNodes}`);
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      start: id(source.start, 'definition.start'),
      nodes: source.nodes.map(normalizeNode),
    };
    const encoded = JSON.stringify(definition);
    if (Buffer.byteLength(encoded, 'utf8') > maxDefinitionBytes) {
      throw new Error(`Workflow definition exceeds ${maxDefinitionBytes} bytes`);
    }
    const errors = [
      ...validateGraph(definition),
      ...validateReferences(definition, options.resolveReference),
    ];
    return errors.length ? { errors } : { definition, errors: [] };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : 'Invalid workflow definition'] };
  }
}

export function normalizeWorkflowDefinition(
  input: unknown,
  options: WorkflowDefinitionOptions = {},
): WorkflowDefinition {
  const result = validateWorkflowDefinition(input, options);
  if (!result.definition) throw new WorkflowSpecError(result.errors);
  return result.definition;
}

export function serializeWorkflowDefinition(definition: WorkflowDefinition): string {
  return JSON.stringify(definition, null, 2);
}
