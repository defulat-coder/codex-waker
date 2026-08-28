import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type AttachmentStatus = 'ready' | 'failed';
export type FileChangeKind = 'add' | 'update' | 'delete';

export interface SessionAttachment {
  id: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  storedPath: string;
  status: AttachmentStatus;
  createdAt: string;
}

export interface SessionArtifact {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  path: string;
  contentPreview: string;
  createdAt: string;
}

export interface SessionFileChange {
  id: string;
  sessionId: string;
  path: string;
  kind: FileChangeKind;
  summary: string;
  createdAt: string;
}

export interface AttachmentDownload {
  attachmentId: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  absolutePath: string;
}

export interface ArtifactStoreOptions {
  storageRoot: string;
  databasePath?: string;
  migrationsDir?: string;
  maxAttachmentBytes?: number;
  now?: () => Date;
}

export type ArtifactStoreErrorCode =
  | 'INVALID_INPUT'
  | 'UNSAFE_PATH'
  | 'SECRET_FILENAME'
  | 'FILE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'NOT_REGULAR_FILE'
  | 'CORRUPT_BLOB';

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

interface AttachmentRow {
  id: string;
  session_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  stored_path: string;
  status: AttachmentStatus;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  title: string;
  kind: string;
  path: string;
  content_preview: string;
  created_at: string;
}

interface FileChangeRow {
  id: string;
  session_id: string;
  path: string;
  kind: FileChangeKind;
  summary: string;
  created_at: string;
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SECRET_FILENAME =
  /(?:^|[._-])(?:\.env|env|id_rsa|id_ed25519|credentials?|secrets?|tokens?|passwords?|api[_-]?keys?)(?:$|[._-])/i;

function attachmentFromRow(row: AttachmentRow): SessionAttachment {
  return {
    id: row.id,
    sessionId: row.session_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    storedPath: row.stored_path,
    status: row.status,
    createdAt: row.created_at,
  };
}

function artifactFromRow(row: ArtifactRow): SessionArtifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    kind: row.kind,
    path: row.path,
    contentPreview: row.content_preview,
    createdAt: row.created_at,
  };
}

function fileChangeFromRow(row: FileChangeRow): SessionFileChange {
  return {
    id: row.id,
    sessionId: row.session_id,
    path: row.path,
    kind: row.kind,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ArtifactStoreError('INVALID_INPUT', `${field} is required`);
  return normalized;
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export class ArtifactStore {
  readonly storageRoot: string;
  readonly maxAttachmentBytes: number;
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: ArtifactStoreOptions) {
    mkdirSync(options.storageRoot, { recursive: true, mode: 0o700 });
    this.storageRoot = realpathSync(resolve(options.storageRoot));
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (!Number.isSafeInteger(this.maxAttachmentBytes) || this.maxAttachmentBytes <= 0)
      throw new ArtifactStoreError('INVALID_INPUT', 'maxAttachmentBytes must be positive');
    this.now = options.now ?? (() => new Date());

    const databasePath = options.databasePath
      ? options.databasePath === ':memory:'
        ? ':memory:'
        : resolve(this.storageRoot, options.databasePath)
      : join(this.storageRoot, 'artifacts.sqlite');
    if (databasePath !== ':memory:') {
      const resolvedDatabase = resolve(databasePath);
      this.assertWithinRoot(resolvedDatabase);
      mkdirSync(dirname(resolvedDatabase), { recursive: true, mode: 0o700 });
      this.assertWithinRoot(realpathSync(dirname(resolvedDatabase)));
    }
    this.db = new Database(databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    const defaultMigrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    this.migrate(options.migrationsDir ?? defaultMigrations);
  }

  close(): void {
    this.db.close();
  }

  migrationVersions(): string[] {
    return (
      this.db
        .prepare('SELECT version FROM artifact_schema_migrations ORDER BY version')
        .all() as Array<{
        version: string;
      }>
    ).map((row) => row.version);
  }

  importBuffer(input: {
    sessionId: string;
    originalName: string;
    mimeType: string;
    data: Buffer;
  }): SessionAttachment {
    const sessionId = requiredText(input.sessionId, 'sessionId');
    const originalName = this.safeFilename(input.originalName);
    const mimeType = requiredText(input.mimeType, 'mimeType');
    if (!Buffer.isBuffer(input.data))
      throw new ArtifactStoreError('INVALID_INPUT', 'data must be a Buffer');
    this.assertSize(input.data.length);
    const sha256 = digest(input.data);
    const existing = this.findAttachmentByHash(sessionId, sha256);
    if (existing) return existing;

    const storedPath = `blobs/${sha256.slice(0, 2)}/${sha256}`;
    this.writeBlob(storedPath, input.data, sha256);
    const now = this.now().toISOString();
    const id = `attachment_${randomUUID().slice(0, 16)}`;
    try {
      this.db.transaction(() => {
        this.ensureSession(sessionId, now);
        this.db
          .prepare(
            `INSERT INTO session_attachments
             (id, session_id, original_name, mime_type, size, sha256, stored_path, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
          )
          .run(id, sessionId, originalName, mimeType, input.data.length, sha256, storedPath, now);
      })();
    } catch (error) {
      const raced = this.findAttachmentByHash(sessionId, sha256);
      if (raced) return raced;
      this.removeBlobIfUnreferenced(storedPath);
      throw error;
    }
    return this.requireAttachment(sessionId, id);
  }

  /** Imports a regular file addressed relative to storageRoot. Absolute/traversal paths are rejected. */
  importPath(input: {
    sessionId: string;
    sourcePath: string;
    originalName?: string;
    mimeType: string;
  }): SessionAttachment {
    const relativePath = this.safeRelativePath(input.sourcePath);
    const source = this.absoluteFor(relativePath);
    let info;
    try {
      info = lstatSync(source);
    } catch {
      throw new ArtifactStoreError('NOT_FOUND', `File not found: ${relativePath}`);
    }
    if (info.isSymbolicLink() || !info.isFile())
      throw new ArtifactStoreError('NOT_REGULAR_FILE', 'sourcePath must be a regular file');
    this.assertWithinRoot(realpathSync(source));
    this.assertSize(info.size);

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const descriptor = openSync(source, constants.O_RDONLY | noFollow);
    let data: Buffer;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile())
        throw new ArtifactStoreError('NOT_REGULAR_FILE', 'sourcePath must be a regular file');
      this.assertSize(opened.size);
      data = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return this.importBuffer({
      sessionId: input.sessionId,
      originalName: input.originalName ?? basename(relativePath),
      mimeType: input.mimeType,
      data,
    });
  }

  listAttachments(sessionId: string): SessionAttachment[] {
    return (
      this.db
        .prepare('SELECT * FROM session_attachments WHERE session_id = ? ORDER BY created_at, id')
        .all(requiredText(sessionId, 'sessionId')) as AttachmentRow[]
    ).map(attachmentFromRow);
  }

  getAttachment(sessionId: string, attachmentId: string): SessionAttachment | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_attachments WHERE session_id = ? AND id = ?')
      .get(requiredText(sessionId, 'sessionId'), requiredText(attachmentId, 'attachmentId')) as
      AttachmentRow | undefined;
    return row ? attachmentFromRow(row) : undefined;
  }

  readAttachment(sessionId: string, attachmentId: string): Buffer {
    const attachment = this.requireAttachment(sessionId, attachmentId);
    const data = this.readManagedFile(attachment.storedPath);
    if (data.length !== attachment.size || digest(data) !== attachment.sha256)
      throw new ArtifactStoreError('CORRUPT_BLOB', `Attachment blob is corrupt: ${attachment.id}`);
    return data;
  }

  downloadMetadata(sessionId: string, attachmentId: string): AttachmentDownload {
    const attachment = this.requireAttachment(sessionId, attachmentId);
    const absolutePath = this.absoluteFor(attachment.storedPath);
    this.assertRegularManagedFile(absolutePath);
    return {
      attachmentId: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sha256: attachment.sha256,
      absolutePath,
    };
  }

  deleteAttachment(sessionId: string, attachmentId: string): boolean {
    const attachment = this.getAttachment(sessionId, attachmentId);
    if (!attachment) return false;
    this.db
      .prepare('DELETE FROM session_attachments WHERE session_id = ? AND id = ?')
      .run(sessionId, attachmentId);
    this.removeBlobIfUnreferenced(attachment.storedPath);
    return true;
  }

  recordArtifact(input: {
    id?: string;
    sessionId: string;
    title: string;
    kind: string;
    path: string;
    contentPreview?: string;
  }): SessionArtifact {
    const sessionId = requiredText(input.sessionId, 'sessionId');
    const id = input.id ?? `artifact_${randomUUID().slice(0, 16)}`;
    const now = this.now().toISOString();
    const path = this.safeRelativePath(input.path);
    this.db.transaction(() => {
      this.ensureSession(sessionId, now);
      this.db
        .prepare(
          `INSERT INTO artifacts(id, session_id, title, kind, path, content_preview, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sessionId,
          requiredText(input.title, 'title'),
          requiredText(input.kind, 'kind'),
          path,
          (input.contentPreview ?? '').slice(0, 4096),
          now,
        );
    })();
    return this.getArtifact(sessionId, id)!;
  }

  listArtifacts(sessionId: string): SessionArtifact[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at, id')
        .all(requiredText(sessionId, 'sessionId')) as ArtifactRow[]
    ).map(artifactFromRow);
  }

  getArtifact(sessionId: string, artifactId: string): SessionArtifact | undefined {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE session_id = ? AND id = ?')
      .get(requiredText(sessionId, 'sessionId'), requiredText(artifactId, 'artifactId')) as
      ArtifactRow | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  readArtifact(sessionId: string, artifactId: string): Buffer {
    const artifact = this.getArtifact(sessionId, artifactId);
    if (!artifact) throw new ArtifactStoreError('NOT_FOUND', `Artifact not found: ${artifactId}`);
    return this.readManagedFile(artifact.path);
  }

  deleteArtifact(sessionId: string, artifactId: string): boolean {
    const artifact = this.getArtifact(sessionId, artifactId);
    if (!artifact) return false;
    this.db
      .prepare('DELETE FROM artifacts WHERE session_id = ? AND id = ?')
      .run(sessionId, artifactId);
    this.removeArtifactFileIfUnreferenced(artifact.path);
    return true;
  }

  recordFileChange(input: {
    id?: string;
    sessionId: string;
    path: string;
    kind: FileChangeKind;
    summary?: string;
  }): SessionFileChange {
    const sessionId = requiredText(input.sessionId, 'sessionId');
    if (!(['add', 'update', 'delete'] as const).includes(input.kind))
      throw new ArtifactStoreError('INVALID_INPUT', `Invalid file change kind: ${input.kind}`);
    const id = input.id ?? `change_${randomUUID().slice(0, 16)}`;
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.ensureSession(sessionId, now);
      this.db
        .prepare(
          `INSERT INTO file_changes(id, session_id, path, kind, summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sessionId,
          this.safeRelativePath(input.path),
          input.kind,
          (input.summary ?? '').slice(0, 4096),
          now,
        );
    })();
    return this.listFileChanges(sessionId).find((entry) => entry.id === id)!;
  }

  listFileChanges(sessionId: string): SessionFileChange[] {
    return (
      this.db
        .prepare('SELECT * FROM file_changes WHERE session_id = ? ORDER BY created_at, id')
        .all(requiredText(sessionId, 'sessionId')) as FileChangeRow[]
    ).map(fileChangeFromRow);
  }

  /** Deletes all session rows and removes blobs no longer referenced by another session. */
  deleteSession(sessionId: string): boolean {
    const normalizedSessionId = requiredText(sessionId, 'sessionId');
    const paths = (
      this.db
        .prepare('SELECT DISTINCT stored_path FROM session_attachments WHERE session_id = ?')
        .all(normalizedSessionId) as Array<{ stored_path: string }>
    ).map((row) => row.stored_path);
    const artifactPaths = (
      this.db
        .prepare('SELECT DISTINCT path FROM artifacts WHERE session_id = ?')
        .all(normalizedSessionId) as Array<{ path: string }>
    ).map((row) => row.path);
    const changed = this.db
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(normalizedSessionId).changes;
    if (!changed) return false;
    for (const path of paths) this.removeBlobIfUnreferenced(path);
    for (const path of artifactPaths) this.removeArtifactFileIfUnreferenced(path);
    return true;
  }

  private migrate(directory: string): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifact_schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(this.migrationVersions());
    const files = readFileNames(directory);
    for (const name of files) {
      const version = name.slice(0, name.indexOf('_'));
      if (applied.has(version)) continue;
      const sql = readFileSync(join(directory, name), 'utf8');
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare(
            'INSERT INTO artifact_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          )
          .run(version, name, this.now().toISOString());
      })();
    }
  }

  private ensureSession(sessionId: string, createdAt: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO sessions(id, created_at) VALUES (?, ?)')
      .run(sessionId, createdAt);
  }

  private findAttachmentByHash(sessionId: string, sha256: string): SessionAttachment | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_attachments WHERE session_id = ? AND sha256 = ?')
      .get(sessionId, sha256) as AttachmentRow | undefined;
    return row ? attachmentFromRow(row) : undefined;
  }

  private requireAttachment(sessionId: string, attachmentId: string): SessionAttachment {
    const attachment = this.getAttachment(sessionId, attachmentId);
    if (!attachment)
      throw new ArtifactStoreError('NOT_FOUND', `Attachment not found: ${attachmentId}`);
    return attachment;
  }

  private assertSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxAttachmentBytes)
      throw new ArtifactStoreError(
        'FILE_TOO_LARGE',
        `Attachment exceeds ${this.maxAttachmentBytes} bytes`,
      );
  }

  private safeFilename(input: string): string {
    const name = requiredText(input, 'originalName');
    if (
      name.includes('\0') ||
      name.includes('/') ||
      name.includes('\\') ||
      name === '.' ||
      name === '..' ||
      isAbsolute(name) ||
      /^[A-Za-z]:[\\/]/.test(name)
    )
      throw new ArtifactStoreError('UNSAFE_PATH', `Unsafe filename: ${name}`);
    if (SECRET_FILENAME.test(name))
      throw new ArtifactStoreError('SECRET_FILENAME', `Secret-like filename rejected: ${name}`);
    return name;
  }

  private safeRelativePath(input: string): string {
    const raw = requiredText(input, 'path');
    if (raw.includes('\0') || raw.includes('\\') || isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw))
      throw new ArtifactStoreError('UNSAFE_PATH', `Path must be relative to storageRoot: ${raw}`);
    const normalized = normalize(raw);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`))
      throw new ArtifactStoreError('UNSAFE_PATH', `Path escapes storageRoot: ${raw}`);
    for (const segment of normalized.split(sep)) this.safeFilename(segment);
    const absolute = resolve(this.storageRoot, normalized);
    this.assertWithinRoot(absolute);
    this.assertExistingPathWithinRoot(absolute);
    return normalized.split(sep).join('/');
  }

  private assertWithinRoot(path: string): void {
    const child = relative(this.storageRoot, resolve(path));
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new ArtifactStoreError('UNSAFE_PATH', `Path escapes storageRoot: ${path}`);
  }

  private absoluteFor(relativePath: string): string {
    const safe = this.safeRelativePath(relativePath);
    const absolute = resolve(this.storageRoot, safe);
    this.assertWithinRoot(absolute);
    return absolute;
  }

  private writeBlob(storedPath: string, data: Buffer, sha256: string): void {
    const target = this.absoluteFor(storedPath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.assertWithinRoot(realpathSync(dirname(target)));
    if (existsSync(target)) {
      this.assertRegularManagedFile(target);
      const current = readFileSync(target);
      if (current.length !== data.length || digest(current) !== sha256)
        throw new ArtifactStoreError('CORRUPT_BLOB', `Existing blob is corrupt: ${storedPath}`);
      return;
    }
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    this.assertWithinRoot(temporary);
    try {
      writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private readManagedFile(storedPath: string): Buffer {
    const absolute = this.absoluteFor(storedPath);
    this.assertRegularManagedFile(absolute);
    return readFileSync(absolute);
  }

  private assertRegularManagedFile(absolute: string): void {
    this.assertWithinRoot(absolute);
    let info;
    try {
      info = lstatSync(absolute);
    } catch {
      throw new ArtifactStoreError('NOT_FOUND', `Stored file not found: ${absolute}`);
    }
    if (info.isSymbolicLink() || !info.isFile())
      throw new ArtifactStoreError(
        'NOT_REGULAR_FILE',
        `Stored path is not a regular file: ${absolute}`,
      );
    this.assertWithinRoot(realpathSync(absolute));
  }

  private removeBlobIfUnreferenced(storedPath: string): void {
    const references = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM session_attachments WHERE stored_path = ?) +
           (SELECT COUNT(*) FROM artifacts WHERE path = ?) AS count`,
      )
      .get(storedPath, storedPath) as { count: number };
    if (references.count > 0) return;
    const absolute = this.absoluteFor(storedPath);
    if (existsSync(absolute)) {
      this.assertRegularManagedFile(absolute);
      unlinkSync(absolute);
    }
  }

  private removeArtifactFileIfUnreferenced(path: string): void {
    this.removeBlobIfUnreferenced(path);
  }

  private assertExistingPathWithinRoot(path: string): void {
    let candidate = path;
    while (!existsSync(candidate)) {
      const parent = dirname(candidate);
      if (parent === candidate) return;
      candidate = parent;
    }
    this.assertWithinRoot(realpathSync(candidate));
  }
}

function readFileNames(directory: string): string[] {
  const directoryInfo = statSync(directory);
  if (!directoryInfo.isDirectory())
    throw new ArtifactStoreError(
      'INVALID_INPUT',
      `Migrations path is not a directory: ${directory}`,
    );
  return readdirSync(directory)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}
