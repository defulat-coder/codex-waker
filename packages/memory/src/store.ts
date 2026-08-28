import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type MemoryScopeType = 'waker' | 'project' | 'group';

export interface MemoryScope {
  type: MemoryScopeType;
  id: string;
}

export interface MemoryDocument {
  id: string;
  scope: MemoryScope;
  source: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersion {
  id: string;
  documentId: string;
  version: number;
  title: string;
  source: string;
  content: string;
  deleted: boolean;
  operation: string;
  createdAt: string;
}

export interface MemorySnapshot {
  id: string;
  documentId: string;
  versionId: string;
  operation: string;
  createdAt: string;
}

export interface MemoryTimelineEntry {
  id: number;
  documentId: string;
  scope: MemoryScope;
  source: string;
  action: string;
  status: string;
  version: number;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  source?: string;
  from?: string;
  to?: string;
}

export type MemoryErrorCode =
  'INVALID_INPUT' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'SCOPE_MISMATCH' | 'IMPORT_CONFLICT';

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

export interface MemoryStoreOptions {
  migrationsDir?: string;
  now?: () => Date;
}

interface DocumentRow {
  id: string;
  scope_type: MemoryScopeType;
  scope_id: string;
  source: string;
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface VersionRow {
  id: string;
  document_id: string;
  version: number;
  title: string;
  source: string;
  content: string;
  deleted: number;
  operation: string;
  created_at: string;
}

interface SnapshotRow {
  id: string;
  document_id: string;
  version_id: string;
  operation: string;
  created_at: string;
}

interface TimelineRow {
  id: number;
  document_id: string;
  scope_type: MemoryScopeType;
  scope_id: string;
  source: string;
  action: string;
  status: string;
  version: number;
  details_json: string;
  created_at: string;
}

interface ExportPayload {
  formatVersion: 1;
  exportedAt: string;
  documents: MemoryDocument[];
}

export function canonicalizeMarkdown(content: string): string {
  const normalized = content
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  if (!normalized) throw new MemoryError('INVALID_INPUT', 'Memory content must not be empty');
  return `${normalized}\n`;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MemoryError('INVALID_INPUT', `${name} is required`);
  return normalized;
}

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toDocument(row: DocumentRow): MemoryDocument {
  return {
    id: row.id,
    scope: { type: row.scope_type, id: row.scope_id },
    source: row.source,
    title: row.title,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion(row: VersionRow): MemoryVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    title: row.title,
    source: row.source,
    content: row.content,
    deleted: row.deleted === 1,
    operation: row.operation,
    createdAt: row.created_at,
  };
}

function toSnapshot(row: SnapshotRow): MemorySnapshot {
  return {
    id: row.id,
    documentId: row.document_id,
    versionId: row.version_id,
    operation: row.operation,
    createdAt: row.created_at,
  };
}

function toTimeline(row: TimelineRow): MemoryTimelineEntry {
  return {
    id: row.id,
    documentId: row.document_id,
    scope: { type: row.scope_type, id: row.scope_id },
    source: row.source,
    action: row.action,
    status: row.status,
    version: row.version,
    details: parseDetails(row.details_json),
    createdAt: row.created_at,
  };
}

export class MemoryStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(file: string, options: MemoryStoreOptions = {}) {
    this.db = new Database(file);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.now = options.now ?? (() => new Date());
    const migrationsDir =
      options.migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    this.migrate(migrationsDir);
  }

  close(): void {
    this.db.close();
  }

  migrationVersions(): number[] {
    return (
      this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map(({ version }) => version);
  }

  create(input: {
    id?: string;
    scope: MemoryScope;
    source: string;
    title: string;
    content: string;
  }): MemoryDocument {
    const id = input.id ?? `memory_${randomUUID()}`;
    const scope = this.normalizeScope(input.scope);
    const source = required(input.source, 'source');
    const title = required(input.title, 'title');
    const content = canonicalizeMarkdown(input.content);
    const timestamp = this.now().toISOString();
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memory_documents
           (id, scope_type, scope_id, source, title, content, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, scope.type, scope.id, source, title, content, timestamp, timestamp);
      this.insertVersion(id, 1, title, source, content, false, 'create', timestamp);
      this.insertTimeline(id, scope, source, 'create', 'success', 1, {}, timestamp);
      return this.requireDocument(id);
    });
    return toDocument(apply());
  }

  get(id: string, scope?: MemoryScope): MemoryDocument {
    const row = this.requireDocument(required(id, 'id'));
    this.assertScope(row, scope);
    return toDocument(row);
  }

  list(filter: MemoryFilter = {}): MemoryDocument[] {
    const { sql, params } = this.filterSql(filter, 'updated_at');
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_documents WHERE deleted_at IS NULL${sql} ORDER BY updated_at DESC, id`,
      )
      .all(...params) as DocumentRow[];
    return rows.map(toDocument);
  }

  update(
    id: string,
    input: {
      expectedVersion: number;
      scope?: MemoryScope;
      source?: string;
      title?: string;
      content?: string;
    },
  ): MemoryDocument {
    return this.write(id, input, 'update');
  }

  delete(id: string, input: { expectedVersion: number; scope?: MemoryScope }): boolean {
    const apply = this.db.transaction(() => {
      const current = this.requireDocument(required(id, 'id'));
      this.assertScope(current, input.scope);
      this.assertVersion(current, input.expectedVersion);
      const timestamp = this.now().toISOString();
      const nextVersion = current.version + 1;
      this.db
        .prepare(
          'UPDATE memory_documents SET version = ?, updated_at = ?, deleted_at = ? WHERE id = ?',
        )
        .run(nextVersion, timestamp, timestamp, current.id);
      this.insertVersion(
        current.id,
        nextVersion,
        current.title,
        current.source,
        current.content,
        true,
        'delete',
        timestamp,
      );
      this.insertTimeline(
        current.id,
        { type: current.scope_type, id: current.scope_id },
        current.source,
        'delete',
        'success',
        nextVersion,
        {},
        timestamp,
      );
      return true;
    });
    return apply();
  }

  listVersions(documentId: string): MemoryVersion[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_versions WHERE document_id = ? ORDER BY version')
        .all(required(documentId, 'documentId')) as VersionRow[]
    ).map(toVersion);
  }

  snapshot(documentId: string, operation = 'manual_snapshot'): MemorySnapshot {
    const current = this.requireDocument(required(documentId, 'documentId'), true);
    return this.insertSnapshot(current.id, current.version, required(operation, 'operation'));
  }

  listSnapshots(documentId: string): MemorySnapshot[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_snapshots WHERE document_id = ? ORDER BY created_at, id')
        .all(required(documentId, 'documentId')) as SnapshotRow[]
    ).map(toSnapshot);
  }

  diff(fromSnapshotId: string, toSnapshotId: string): string {
    const from = this.snapshotVersion(fromSnapshotId);
    const to = this.snapshotVersion(toSnapshotId);
    if (from.documentId !== to.documentId) {
      throw new MemoryError('INVALID_INPUT', 'Snapshots must belong to the same document');
    }
    return unifiedLineDiff(from.content, to.content, fromSnapshotId, toSnapshotId);
  }

  rollback(
    snapshotId: string,
    input: { expectedVersion: number; scope?: MemoryScope; apply?: boolean },
  ): {
    applied: boolean;
    document: MemoryDocument;
    preRollbackSnapshot?: MemorySnapshot;
    diff: string;
  } {
    const target = this.snapshotVersion(snapshotId);
    const current = this.requireDocument(target.documentId, true);
    this.assertScope(current, input.scope);
    this.assertVersion(current, input.expectedVersion);
    const diff = unifiedLineDiff(current.content, target.content, 'current', snapshotId);
    if (input.apply !== true) return { applied: false, document: toDocument(current), diff };

    const apply = this.db.transaction(() => {
      const fresh = this.requireDocument(target.documentId, true);
      this.assertVersion(fresh, input.expectedVersion);
      const preRollbackSnapshot = this.insertSnapshot(fresh.id, fresh.version, 'pre_rollback');
      const document = this.write(
        fresh.id,
        {
          expectedVersion: fresh.version,
          source: target.source,
          title: target.title,
          content: target.content,
        },
        'rollback',
      );
      return { applied: true as const, document, preRollbackSnapshot, diff };
    });
    return apply();
  }

  listTimeline(
    filter: MemoryFilter & { documentId?: string; action?: string } = {},
  ): MemoryTimelineEntry[] {
    const { sql, params } = this.filterSql(filter, 'created_at', 'memory_timeline');
    const clauses = [sql];
    if (filter.documentId) {
      clauses.push(' AND document_id = ?');
      params.push(filter.documentId);
    }
    if (filter.action) {
      clauses.push(' AND action = ?');
      params.push(filter.action);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_timeline WHERE 1 = 1${clauses.join('')} ORDER BY created_at, id`,
        )
        .all(...params) as TimelineRow[]
    ).map(toTimeline);
  }

  listAudits(
    filter: MemoryFilter & { documentId?: string; action?: string } = {},
  ): MemoryTimelineEntry[] {
    return this.listTimeline(filter);
  }

  exportJson(filter: MemoryFilter = {}): string {
    const payload: ExportPayload = {
      formatVersion: 1,
      exportedAt: this.now().toISOString(),
      documents: this.list(filter),
    };
    return JSON.stringify(payload, null, 2);
  }

  importJson(json: string): MemoryDocument[] {
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      throw new MemoryError('INVALID_INPUT', 'Memory JSON is invalid');
    }
    if (!isExportPayload(payload)) {
      throw new MemoryError('INVALID_INPUT', 'Unsupported memory JSON format');
    }
    const apply = this.db.transaction(() =>
      payload.documents.map((document) => {
        const existing = this.db
          .prepare('SELECT id FROM memory_documents WHERE id = ?')
          .get(document.id) as { id: string } | undefined;
        if (existing) {
          throw new MemoryError('IMPORT_CONFLICT', `Memory already exists: ${document.id}`);
        }
        return this.create({
          id: document.id,
          scope: document.scope,
          source: document.source,
          title: document.title,
          content: document.content,
        });
      }),
    );
    return apply();
  }

  exportMarkdown(documentId: string, scope?: MemoryScope): string {
    return this.get(documentId, scope).content;
  }

  importMarkdown(input: {
    id?: string;
    scope: MemoryScope;
    source: string;
    title: string;
    markdown: string;
  }): MemoryDocument {
    return this.create({ ...input, content: input.markdown });
  }

  countRows(
    table: 'memory_documents' | 'memory_versions' | 'memory_snapshots' | 'memory_timeline',
  ): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
      .count;
  }

  private migrate(directory: string): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(this.migrationVersions());
    for (const name of readdirSync(directory)
      .filter((item) => /^\d+_.+\.sql$/.test(item))
      .sort()) {
      const version = Number.parseInt(name, 10);
      if (applied.has(version)) continue;
      const sql = readFileSync(join(directory, name), 'utf8');
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(version, name, this.now().toISOString());
      })();
    }
  }

  private write(
    id: string,
    input: {
      expectedVersion: number;
      scope?: MemoryScope;
      source?: string;
      title?: string;
      content?: string;
    },
    operation: string,
  ): MemoryDocument {
    const apply = this.db.transaction(() => {
      const current = this.requireDocument(required(id, 'id'), operation === 'rollback');
      this.assertScope(current, input.scope);
      this.assertVersion(current, input.expectedVersion);
      if (input.source === undefined && input.title === undefined && input.content === undefined) {
        throw new MemoryError('INVALID_INPUT', 'At least one field must be updated');
      }
      const next = {
        source: input.source === undefined ? current.source : required(input.source, 'source'),
        title: input.title === undefined ? current.title : required(input.title, 'title'),
        content:
          input.content === undefined ? current.content : canonicalizeMarkdown(input.content),
        version: current.version + 1,
        updatedAt: this.now().toISOString(),
      };
      this.db
        .prepare(
          `UPDATE memory_documents
           SET source = ?, title = ?, content = ?, version = ?, updated_at = ?, deleted_at = NULL
           WHERE id = ?`,
        )
        .run(next.source, next.title, next.content, next.version, next.updatedAt, current.id);
      this.insertVersion(
        current.id,
        next.version,
        next.title,
        next.source,
        next.content,
        false,
        operation,
        next.updatedAt,
      );
      this.insertTimeline(
        current.id,
        { type: current.scope_type, id: current.scope_id },
        next.source,
        operation,
        'success',
        next.version,
        {},
        next.updatedAt,
      );
      return this.requireDocument(current.id);
    });
    return toDocument(apply());
  }

  private requireDocument(id: string, includeDeleted = false): DocumentRow {
    const row = this.db.prepare('SELECT * FROM memory_documents WHERE id = ?').get(id) as
      DocumentRow | undefined;
    if (!row || (!includeDeleted && row.deleted_at)) {
      throw new MemoryError('NOT_FOUND', `Memory not found: ${id}`);
    }
    return row;
  }

  private assertScope(row: DocumentRow, scope?: MemoryScope): void {
    if (!scope) return;
    const normalized = this.normalizeScope(scope);
    if (row.scope_type !== normalized.type || row.scope_id !== normalized.id) {
      throw new MemoryError(
        'SCOPE_MISMATCH',
        `Memory does not belong to ${normalized.type}:${normalized.id}`,
      );
    }
  }

  private assertVersion(row: DocumentRow, expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new MemoryError('INVALID_INPUT', 'expectedVersion must be a positive integer');
    }
    if (row.version !== expectedVersion) {
      throw new MemoryError(
        'VERSION_CONFLICT',
        `Memory version conflict: expected ${expectedVersion}, current ${row.version}`,
      );
    }
  }

  private normalizeScope(scope: MemoryScope): MemoryScope {
    if (!['waker', 'project', 'group'].includes(scope.type)) {
      throw new MemoryError('INVALID_INPUT', `Unsupported memory scope: ${scope.type}`);
    }
    return { type: scope.type, id: required(scope.id, 'scope.id') };
  }

  private insertVersion(
    documentId: string,
    version: number,
    title: string,
    source: string,
    content: string,
    deleted: boolean,
    operation: string,
    createdAt: string,
  ): string {
    const id = `version_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO memory_versions
         (id, document_id, version, title, source, content, deleted, operation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, documentId, version, title, source, content, deleted ? 1 : 0, operation, createdAt);
    return id;
  }

  private insertSnapshot(documentId: string, version: number, operation: string): MemorySnapshot {
    const row = this.db
      .prepare('SELECT id FROM memory_versions WHERE document_id = ? AND version = ?')
      .get(documentId, version) as { id: string } | undefined;
    if (!row)
      throw new MemoryError('NOT_FOUND', `Memory version not found: ${documentId}@${version}`);
    const snapshot: MemorySnapshot = {
      id: `snapshot_${randomUUID()}`,
      documentId,
      versionId: row.id,
      operation,
      createdAt: this.now().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO memory_snapshots(id, document_id, version_id, operation, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        snapshot.id,
        snapshot.documentId,
        snapshot.versionId,
        snapshot.operation,
        snapshot.createdAt,
      );
    return snapshot;
  }

  private snapshotVersion(snapshotId: string): MemoryVersion {
    const row = this.db
      .prepare(
        `SELECT v.* FROM memory_snapshots s
         JOIN memory_versions v ON v.id = s.version_id
         WHERE s.id = ?`,
      )
      .get(required(snapshotId, 'snapshotId')) as VersionRow | undefined;
    if (!row) throw new MemoryError('NOT_FOUND', `Memory snapshot not found: ${snapshotId}`);
    return toVersion(row);
  }

  private insertTimeline(
    documentId: string,
    scope: MemoryScope,
    source: string,
    action: string,
    status: string,
    version: number,
    details: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_timeline
         (document_id, scope_type, scope_id, source, action, status, version, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        scope.type,
        scope.id,
        source,
        action,
        status,
        version,
        JSON.stringify(details),
        createdAt,
      );
  }

  private filterSql(
    filter: MemoryFilter,
    timeColumn: 'created_at' | 'updated_at',
    table = 'memory_documents',
  ): { sql: string; params: string[] } {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.scope) {
      const scope = this.normalizeScope(filter.scope);
      clauses.push(` AND ${table}.scope_type = ? AND ${table}.scope_id = ?`);
      params.push(scope.type, scope.id);
    }
    if (filter.source) {
      clauses.push(` AND ${table}.source = ?`);
      params.push(required(filter.source, 'source'));
    }
    if (filter.from) {
      clauses.push(` AND ${table}.${timeColumn} >= ?`);
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push(` AND ${table}.${timeColumn} <= ?`);
      params.push(filter.to);
    }
    return { sql: clauses.join(''), params };
  }
}

function isExportPayload(value: unknown): value is ExportPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.formatVersion === 1 &&
    Array.isArray(record.documents) &&
    record.documents.every(isDocument)
  );
}

function isDocument(value: unknown): value is MemoryDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const scope = record.scope;
  return (
    typeof record.id === 'string' &&
    typeof record.source === 'string' &&
    typeof record.title === 'string' &&
    typeof record.content === 'string' &&
    Boolean(scope) &&
    typeof scope === 'object' &&
    !Array.isArray(scope) &&
    ['waker', 'project', 'group'].includes(String((scope as Record<string, unknown>).type)) &&
    typeof (scope as Record<string, unknown>).id === 'string'
  );
}

function unifiedLineDiff(
  before: string,
  after: string,
  beforeLabel: string,
  afterLabel: string,
): string {
  if (before === after) return `--- ${beforeLabel}\n+++ ${afterLabel}\n`;
  const left = before.trimEnd().split('\n');
  const right = after.trimEnd().split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const unchangedStart = left.slice(Math.max(0, prefix - 2), prefix).map((line) => ` ${line}`);
  const removed = left.slice(prefix, left.length - suffix).map((line) => `-${line}`);
  const added = right.slice(prefix, right.length - suffix).map((line) => `+${line}`);
  const unchangedEnd = left
    .slice(left.length - suffix, Math.min(left.length, left.length - suffix + 2))
    .map((line) => ` ${line}`);
  return [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    '@@',
    ...unchangedStart,
    ...removed,
    ...added,
    ...unchangedEnd,
    '',
  ].join('\n');
}
