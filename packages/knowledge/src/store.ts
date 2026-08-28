import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { cosineSimilarity, LocalHashEmbedding, type EmbeddingAdapter } from './embedding.js';

export type SearchMode = 'keyword' | 'vector' | 'hybrid';

export interface BindingContext {
  scopeType: string;
  scopeId: string;
}

export interface NotebookBinding extends BindingContext {
  id: string;
  notebookId: string;
  canWrite: boolean;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  notebookId: string;
  documentId?: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface Notebook {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord {
  id: string;
  notebookId: string;
  title: string;
  sourceUri?: string;
  currentVersion: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion extends DocumentRecord {
  content: string;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  notebookId: string;
  title: string;
  content: string;
  version: number;
  score: number;
  keywordScore?: number;
  vectorScore?: number;
  citation: {
    documentId: string;
    title: string;
    sourceUri?: string;
    version: number;
    startLine: number;
    endLine: number;
  };
}

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  notebookId?: string;
  binding?: BindingContext;
}

export interface KnowledgeStoreOptions {
  embedding?: EmbeddingAdapter;
  migrationsDir?: string;
  chunkSize?: number;
}

export type KnowledgeErrorCode = 'NOT_FOUND' | 'VERSION_CONFLICT' | 'FORBIDDEN' | 'READ_ONLY';

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

interface DocumentRow {
  id: string;
  notebook_id: string;
  title: string;
  source_uri: string | null;
  current_version: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  notebook_id: string;
  title: string;
  source_uri: string | null;
  version: number;
  content: string;
  start_line: number;
  end_line: number;
  vector_json?: string;
  rank?: number;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function documentFromRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    ...(row.source_uri ? { sourceUri: row.source_uri } : {}),
    currentVersion: row.current_version,
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ftsQuery(query: string): string {
  return (query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' OR ');
}

function chunksFor(
  content: string,
  maxChars: number,
): Array<{
  content: string;
  startLine: number;
  endLine: number;
}> {
  const lines = content.split('\n');
  const chunks: Array<{ content: string; startLine: number; endLine: number }> = [];
  let start = 0;
  let current: string[] = [];
  const flush = (end: number) => {
    if (!current.length) return;
    chunks.push({ content: current.join('\n'), startLine: start + 1, endLine: end + 1 });
    current = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const candidateLength = current.reduce((sum, item) => sum + item.length + 1, 0) + line.length;
    if (current.length && candidateLength > maxChars) {
      flush(index - 1);
      start = index;
    }
    current.push(line);
  }
  flush(lines.length - 1);
  return chunks;
}

export class KnowledgeStore {
  private readonly db: Database.Database;
  private readonly embedding: EmbeddingAdapter;
  private readonly chunkSize: number;

  constructor(file: string, options: KnowledgeStoreOptions = {}) {
    this.db = new Database(file);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.embedding = options.embedding ?? new LocalHashEmbedding();
    this.chunkSize = options.chunkSize ?? 800;
    const defaultMigrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    this.migrate(options.migrationsDir ?? defaultMigrations);
  }

  close(): void {
    this.db.close();
  }

  migrationVersions(): number[] {
    return (
      this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((row) => row.version);
  }

  private migrate(directory: string): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(this.migrationVersions());
    const files = readdirSync(directory)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    for (const name of files) {
      const version = Number.parseInt(name, 10);
      if (applied.has(version)) continue;
      const sql = readFileSync(join(directory, name), 'utf8');
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(version, name, new Date().toISOString());
      })();
    }
  }

  createNotebook(input: { id?: string; name: string; description?: string }): Notebook {
    const id = input.id ?? `notebook_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO notebooks(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name.trim(), input.description?.trim() ?? '', now, now);
    this.audit(id, undefined, 'notebook.created', { name: input.name.trim() });
    return {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
    };
  }

  listNotebooks(binding?: BindingContext): Notebook[] {
    const rows = binding
      ? (this.db
          .prepare(
            `SELECT n.* FROM notebooks n JOIN bindings b ON b.notebook_id = n.id
             WHERE b.scope_type = ? AND b.scope_id = ? ORDER BY n.created_at`,
          )
          .all(binding.scopeType, binding.scopeId) as Array<{
          id: string;
          name: string;
          description: string;
          created_at: string;
          updated_at: string;
        }>)
      : (this.db.prepare('SELECT * FROM notebooks ORDER BY created_at').all() as Array<{
          id: string;
          name: string;
          description: string;
          created_at: string;
          updated_at: string;
        }>);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateNotebook(
    id: string,
    patch: { name?: string; description?: string; binding?: BindingContext },
  ): Notebook {
    this.assertAccess(id, patch.binding, true);
    const current = this.listNotebooks(patch.binding).find((entry) => entry.id === id);
    if (!current) throw new KnowledgeError('NOT_FOUND', `Notebook not found: ${id}`);
    const now = new Date().toISOString();
    const next = {
      ...current,
      name: patch.name?.trim() ?? current.name,
      description: patch.description?.trim() ?? current.description,
      updatedAt: now,
    };
    this.db
      .prepare('UPDATE notebooks SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, now, id);
    this.audit(id, undefined, 'notebook.updated', { name: next.name });
    return next;
  }

  deleteNotebook(id: string, binding?: BindingContext): boolean {
    this.assertAccess(id, binding, true);
    const changed = this.db.prepare('DELETE FROM notebooks WHERE id = ?').run(id).changes > 0;
    if (changed) this.audit(id, undefined, 'notebook.deleted', {});
    return changed;
  }

  bindNotebook(notebookId: string, binding: BindingContext, canWrite = false): void {
    this.requireNotebook(notebookId);
    this.db
      .prepare(
        `INSERT INTO bindings(id, notebook_id, scope_type, scope_id, can_write, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(notebook_id, scope_type, scope_id) DO UPDATE SET can_write = excluded.can_write`,
      )
      .run(
        `binding_${randomUUID().slice(0, 12)}`,
        notebookId,
        binding.scopeType,
        binding.scopeId,
        canWrite ? 1 : 0,
        new Date().toISOString(),
      );
    this.audit(notebookId, undefined, 'binding.updated', { ...binding, canWrite });
  }

  unbindNotebook(notebookId: string, binding: BindingContext): boolean {
    this.requireNotebook(notebookId);
    const changed =
      this.db
        .prepare('DELETE FROM bindings WHERE notebook_id = ? AND scope_type = ? AND scope_id = ?')
        .run(notebookId, binding.scopeType, binding.scopeId).changes > 0;
    if (changed) this.audit(notebookId, undefined, 'binding.removed', { ...binding });
    return changed;
  }

  listBindings(notebookId?: string): NotebookBinding[] {
    const rows = (
      notebookId
        ? this.db
            .prepare('SELECT * FROM bindings WHERE notebook_id = ? ORDER BY created_at, id')
            .all(notebookId)
        : this.db.prepare('SELECT * FROM bindings ORDER BY created_at, id').all()
    ) as Array<{
      id: string;
      notebook_id: string;
      scope_type: string;
      scope_id: string;
      can_write: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      notebookId: row.notebook_id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      canWrite: row.can_write === 1,
      createdAt: row.created_at,
    }));
  }

  listAudits(notebookId?: string): AuditEntry[] {
    const rows = (
      notebookId
        ? this.db.prepare('SELECT * FROM audits WHERE notebook_id = ? ORDER BY id').all(notebookId)
        : this.db.prepare('SELECT * FROM audits ORDER BY id').all()
    ) as Array<{
      id: number;
      notebook_id: string;
      document_id: string | null;
      action: string;
      details_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      notebookId: row.notebook_id,
      ...(row.document_id ? { documentId: row.document_id } : {}),
      action: row.action,
      details: parseObject(row.details_json),
      createdAt: row.created_at,
    }));
  }

  async createDocument(input: {
    id?: string;
    notebookId: string;
    title: string;
    content: string;
    sourceUri?: string;
    metadata?: Record<string, unknown>;
    binding?: BindingContext;
  }): Promise<DocumentVersion> {
    this.assertAccess(input.notebookId, input.binding, true);
    const id = input.id ?? `document_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO documents(id, notebook_id, title, source_uri, current_version, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          id,
          input.notebookId,
          input.title.trim(),
          input.sourceUri ?? null,
          JSON.stringify(input.metadata ?? {}),
          now,
          now,
        );
      this.insertVersion(id, 1, input.content, now);
    })();
    await this.indexVersion(id, 1, input.content);
    this.audit(input.notebookId, id, 'document.created', { version: 1 });
    return this.getDocument(id, input.binding);
  }

  getDocument(id: string, binding?: BindingContext): DocumentVersion {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      DocumentRow | undefined;
    if (!row) throw new KnowledgeError('NOT_FOUND', `Document not found: ${id}`);
    this.assertAccess(row.notebook_id, binding, false);
    const version = this.db
      .prepare('SELECT content FROM document_versions WHERE document_id = ? AND version = ?')
      .get(id, row.current_version) as { content: string };
    return { ...documentFromRow(row), content: version.content };
  }

  listDocuments(notebookId: string, binding?: BindingContext): DocumentRecord[] {
    this.assertAccess(notebookId, binding, false);
    return (
      this.db
        .prepare('SELECT * FROM documents WHERE notebook_id = ? ORDER BY created_at, id')
        .all(notebookId) as DocumentRow[]
    ).map(documentFromRow);
  }

  getDocumentVersion(id: string, version: number, binding?: BindingContext): DocumentVersion {
    const document = this.getDocument(id, binding);
    const row = this.db
      .prepare('SELECT content FROM document_versions WHERE document_id = ? AND version = ?')
      .get(id, version) as { content: string } | undefined;
    if (!row) throw new KnowledgeError('NOT_FOUND', `Document version not found: ${id}@${version}`);
    return { ...document, currentVersion: version, content: row.content };
  }

  async updateDocument(
    id: string,
    input: {
      expectedVersion: number;
      content: string;
      title?: string;
      sourceUri?: string | null;
      metadata?: Record<string, unknown>;
      binding?: BindingContext;
    },
  ): Promise<DocumentVersion> {
    const current = this.getDocument(id, input.binding);
    this.assertAccess(current.notebookId, input.binding, true);
    if (current.currentVersion !== input.expectedVersion)
      throw new KnowledgeError(
        'VERSION_CONFLICT',
        `Expected version ${input.expectedVersion}, current version is ${current.currentVersion}`,
      );
    const version = current.currentVersion + 1;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.insertVersion(id, version, input.content, now);
      this.db
        .prepare(
          `UPDATE documents SET current_version = ?, title = ?, source_uri = ?, metadata_json = ?, updated_at = ?
           WHERE id = ? AND current_version = ?`,
        )
        .run(
          version,
          input.title?.trim() ?? current.title,
          input.sourceUri === undefined ? (current.sourceUri ?? null) : input.sourceUri,
          JSON.stringify(input.metadata ?? current.metadata),
          now,
          id,
          input.expectedVersion,
        );
    })();
    await this.indexVersion(id, version, input.content);
    this.audit(current.notebookId, id, 'document.updated', { version });
    return this.getDocument(id, input.binding);
  }

  deleteDocument(id: string, binding?: BindingContext): boolean {
    const current = this.getDocument(id, binding);
    this.assertAccess(current.notebookId, binding, true);
    const changed = this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
    if (changed)
      this.audit(current.notebookId, id, 'document.deleted', { version: current.currentVersion });
    return changed;
  }

  async rebuild(
    input: { notebookId?: string; documentId?: string; force?: boolean } = {},
  ): Promise<number> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.notebookId) {
      clauses.push('notebook_id = ?');
      params.push(input.notebookId);
    }
    if (input.documentId) {
      clauses.push('id = ?');
      params.push(input.documentId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM documents${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`)
      .all(...params) as DocumentRow[];
    let rebuilt = 0;
    for (const row of rows) {
      const counts = this.db
        .prepare(
          `SELECT COUNT(*) AS chunks,
             (SELECT COUNT(*) FROM embeddings e JOIN chunks c2 ON c2.id = e.chunk_id
              WHERE c2.document_id = ? AND c2.version = ?) AS embeddings
           FROM chunks WHERE document_id = ? AND version = ?`,
        )
        .get(row.id, row.current_version, row.id, row.current_version) as {
        chunks: number;
        embeddings: number;
      };
      if (!input.force && counts.chunks > 0 && counts.chunks === counts.embeddings) continue;
      const { content } = this.db
        .prepare('SELECT content FROM document_versions WHERE document_id = ? AND version = ?')
        .get(row.id, row.current_version) as { content: string };
      this.db
        .prepare('DELETE FROM chunks WHERE document_id = ? AND version = ?')
        .run(row.id, row.current_version);
      await this.indexVersion(row.id, row.current_version, content);
      this.audit(row.notebook_id, row.id, 'index.rebuilt', { version: row.current_version });
      rebuilt += 1;
    }
    return rebuilt;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const mode = options.mode ?? 'hybrid';
    const keyword = mode === 'vector' ? [] : this.keywordSearch(query, options, limit * 4);
    let vector: Array<{ row: ChunkRow; score: number }> = [];
    if (mode !== 'keyword') {
      try {
        vector = await this.vectorSearch(query, options, limit * 4);
      } catch {
        // Embedding providers are optional. Keyword retrieval remains usable offline/on failure.
        return this.finishResults(
          this.keywordSearch(query, options, limit * 4),
          [],
          limit,
          'keyword',
        );
      }
    }
    return this.finishResults(keyword, vector, limit, mode);
  }

  countRows(
    table:
      | 'documents'
      | 'document_versions'
      | 'chunks'
      | 'chunks_fts'
      | 'embeddings'
      | 'bindings'
      | 'audits',
  ): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
      .count;
  }

  private insertVersion(documentId: string, version: number, content: string, now: string): void {
    this.db
      .prepare(
        'INSERT INTO document_versions(document_id, version, content, content_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(documentId, version, content, hash(content), now);
  }

  private async indexVersion(documentId: string, version: number, content: string): Promise<void> {
    const parts = chunksFor(content, this.chunkSize);
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO chunks(id, document_id, version, ordinal, content, start_line, end_line, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    this.db.transaction(() => {
      for (const [ordinal, part] of parts.entries()) {
        const id = `${documentId}:v${version}:c${ordinal}`;
        ids.push(id);
        insert.run(
          id,
          documentId,
          version,
          ordinal,
          part.content,
          part.startLine,
          part.endLine,
          hash(part.content),
        );
      }
    })();
    try {
      const vectors = await this.embedding.embed(parts.map((part) => part.content));
      if (vectors.length !== parts.length) throw new Error('Embedding count mismatch');
      const insertEmbedding = this.db.prepare(
        `INSERT OR REPLACE INTO embeddings(chunk_id, model, dimensions, vector_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      this.db.transaction(() => {
        for (const [index, vector] of vectors.entries()) {
          if (!vector || vector.length !== this.embedding.dimensions)
            throw new Error('Embedding dimensions mismatch');
          insertEmbedding.run(
            ids[index],
            this.embedding.model,
            vector.length,
            JSON.stringify(vector),
            now,
          );
        }
      })();
    } catch {
      // Chunks + FTS are committed independently so semantic indexing failures degrade to keyword.
    }
  }

  private keywordSearch(
    query: string,
    options: SearchOptions,
    limit: number,
  ): Array<{ row: ChunkRow; score: number }> {
    const match = ftsQuery(query);
    if (!match) return [];
    const { sql, params } = this.accessFilter(options, 'd');
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id, d.notebook_id, d.title, d.source_uri, c.version, c.content,
                c.start_line, c.end_line, bm25(chunks_fts) AS rank
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ? AND c.version = d.current_version ${sql}
         ORDER BY rank LIMIT ?`,
      )
      .all(match, ...params, limit) as ChunkRow[];
    return rows.map((row) => ({ row, score: 1 / (1 + Math.max(0, row.rank ?? 0)) }));
  }

  private async vectorSearch(
    query: string,
    options: SearchOptions,
    limit: number,
  ): Promise<Array<{ row: ChunkRow; score: number }>> {
    const [needle] = await this.embedding.embed([query]);
    if (!needle || needle.length !== this.embedding.dimensions)
      throw new Error('Query embedding failed');
    const { sql, params } = this.accessFilter(options, 'd');
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id, d.notebook_id, d.title, d.source_uri, c.version, c.content,
                c.start_line, c.end_line, e.vector_json
         FROM embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id
         WHERE c.version = d.current_version AND e.model = ? AND e.dimensions = ? ${sql}`,
      )
      .all(this.embedding.model, this.embedding.dimensions, ...params) as ChunkRow[];
    // ponytail: O(n) JSON vector scan is deliberate for local datasets; replace with sqlite-vec after profiling proves the ceiling.
    return rows
      .map((row) => ({
        row,
        score: cosineSimilarity(needle, JSON.parse(row.vector_json ?? '[]') as number[]),
      }))
      .sort((left, right) => right.score - left.score || left.row.id.localeCompare(right.row.id))
      .slice(0, limit);
  }

  private finishResults(
    keyword: Array<{ row: ChunkRow; score: number }>,
    vector: Array<{ row: ChunkRow; score: number }>,
    limit: number,
    mode: SearchMode,
  ): SearchResult[] {
    const merged = new Map<
      string,
      { row: ChunkRow; keywordScore?: number; vectorScore?: number }
    >();
    for (const item of keyword)
      merged.set(item.row.id, { row: item.row, keywordScore: item.score });
    for (const item of vector) {
      const previous = merged.get(item.row.id);
      merged.set(item.row.id, { ...(previous ?? { row: item.row }), vectorScore: item.score });
    }
    return [...merged.values()]
      .map((item) => {
        const score =
          mode === 'keyword'
            ? (item.keywordScore ?? 0)
            : mode === 'vector'
              ? (item.vectorScore ?? 0)
              : 0.45 * (item.keywordScore ?? 0) + 0.55 * Math.max(0, item.vectorScore ?? 0);
        return {
          chunkId: item.row.id,
          documentId: item.row.document_id,
          notebookId: item.row.notebook_id,
          title: item.row.title,
          content: item.row.content,
          version: item.row.version,
          score,
          ...(item.keywordScore !== undefined ? { keywordScore: item.keywordScore } : {}),
          ...(item.vectorScore !== undefined ? { vectorScore: item.vectorScore } : {}),
          citation: {
            documentId: item.row.document_id,
            title: item.row.title,
            ...(item.row.source_uri ? { sourceUri: item.row.source_uri } : {}),
            version: item.row.version,
            startLine: item.row.start_line,
            endLine: item.row.end_line,
          },
        } satisfies SearchResult;
      })
      .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
      .slice(0, limit);
  }

  private accessFilter(options: SearchOptions, alias: string): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.notebookId) {
      clauses.push(`${alias}.notebook_id = ?`);
      params.push(options.notebookId);
    }
    if (options.binding) {
      clauses.push(
        `EXISTS (SELECT 1 FROM bindings b WHERE b.notebook_id = ${alias}.notebook_id AND b.scope_type = ? AND b.scope_id = ?)`,
      );
      params.push(options.binding.scopeType, options.binding.scopeId);
    }
    return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
  }

  private assertAccess(
    notebookId: string,
    binding: BindingContext | undefined,
    write: boolean,
  ): void {
    this.requireNotebook(notebookId);
    if (!binding) return;
    const row = this.db
      .prepare(
        'SELECT can_write FROM bindings WHERE notebook_id = ? AND scope_type = ? AND scope_id = ?',
      )
      .get(notebookId, binding.scopeType, binding.scopeId) as { can_write: number } | undefined;
    if (!row) throw new KnowledgeError('FORBIDDEN', 'Notebook is not bound to this scope');
    if (write && row.can_write !== 1)
      throw new KnowledgeError('READ_ONLY', 'Notebook binding is read-only');
  }

  private requireNotebook(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(id))
      throw new KnowledgeError('NOT_FOUND', `Notebook not found: ${id}`);
  }

  private audit(
    notebookId: string,
    documentId: string | undefined,
    action: string,
    details: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        'INSERT INTO audits(notebook_id, document_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        notebookId,
        documentId ?? null,
        action,
        JSON.stringify(details),
        new Date().toISOString(),
      );
  }
}
