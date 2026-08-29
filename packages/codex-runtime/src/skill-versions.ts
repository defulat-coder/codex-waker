import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  SkillDiffFileChange,
  SkillRollbackPlan,
  SkillSafetyFinding,
  SkillScanReport,
  SkillScanSummary,
  SkillVersionChanges,
  SkillVersionDetail,
  SkillVersionFileEntry,
  SkillVersionTrigger,
} from '@waker/contracts';
import { scanSkillText, summarizeSkillScan } from './skill-safety.js';

/**
 * Snapshot-style content versioning for `.agents/skills/`.
 *
 * The Skills CLI owns install/remove of that directory; this module never installs or
 * uninstalls skills. A version is a read-only fingerprint + content archive taken at a
 * point in time, stored under `.codex/skill-versions/vNNNNNN/` (manifest.json + files/).
 * Rollback is the one write path: it restores archived file contents and deletes files
 * added after the snapshot, always after archiving the current state as a new version.
 * If the CLI later reinstalls a skill it overwrites rollback results — that is expected.
 */

const SKILLS_DIR = join('.agents', 'skills');
const VERSIONS_DIR = join('.codex', 'skill-versions');
/** Files above this size are fingerprinted but their content is not archived. */
const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024;
/** Safety valve against runaway directories; a real skills tree is ~hundreds of files. */
const MAX_TREE_FILES = 2000;
const DIFF_CONTEXT_LINES = 3;
/** Above this line count an LCS matrix is not worth it; fall back to whole-file replace. */
const DIFF_MAX_LINES = 2000;
const VERSION_ID_REGEX = /^v(\d{6})$/;

export class SkillVersionNotFoundError extends Error {
  constructor(id: string) {
    super(`技能版本不存在：${id}`);
    this.name = 'SkillVersionNotFoundError';
  }
}

interface TreeFile extends SkillVersionFileEntry {
  content?: Buffer;
}

interface SkillVersionManifest {
  id: string;
  createdAt: string;
  label?: string;
  trigger: SkillVersionTrigger;
  fingerprint: string;
  files: SkillVersionFileEntry[];
  changes: SkillVersionChanges;
  scan?: SkillScanSummary;
}

function isWithin(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
}

/** Archive/manifest paths are repo-relative POSIX paths; refuse anything path-ish. */
function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment && !/^\.+$/.test(segment));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Walks `.agents/skills` read-only; symlinks are never followed or archived. */
function scanSkillsTree(cwd: string): TreeFile[] {
  const root = join(cwd, SKILLS_DIR);
  const files: TreeFile[] = [];
  if (!existsSync(root)) return files;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (files.length >= MAX_TREE_FILES)
        throw new Error(`技能目录文件超过 ${MAX_TREE_FILES} 个，拒绝快照`);
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(root, absolute).split(sep).join('/');
      if (!isSafeRelativePath(path)) continue;
      const content = readFileSync(absolute);
      const archived = content.byteLength <= MAX_ARCHIVE_FILE_BYTES;
      files.push({
        path,
        sha256: sha256(content),
        size: content.byteLength,
        archived,
        ...(archived ? { content } : {}),
      });
    }
  };
  visit(root);
  return files;
}

function fingerprintOf(files: SkillVersionFileEntry[]): string {
  const payload = files
    .map((file) => `${file.path}\0${file.sha256}\0${file.archived ? 1 : 0}`)
    .join('\n');
  return sha256(Buffer.from(payload, 'utf8'));
}

function computeChanges(
  previous: SkillVersionFileEntry[],
  next: SkillVersionFileEntry[],
): SkillVersionChanges {
  const before = new Map(previous.map((file) => [file.path, file.sha256]));
  const after = new Map(next.map((file) => [file.path, file.sha256]));
  const added: string[] = [];
  const modified: string[] = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== hash) modified.push(path);
  }
  const deleted = [...before.keys()].filter((path) => !after.has(path));
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function versionsRoot(cwd: string): string {
  return join(cwd, VERSIONS_DIR);
}

/**
 * 入站面检测钩子：对新增/修改的文本文件跑确定性安全扫描。
 * 二进制与未归档（>1MB）文件没有内容可扫，跳过；扫描只报告不拦截。
 */
function scanChangedFiles(
  tree: TreeFile[],
  changes: SkillVersionChanges,
): SkillScanSummary | undefined {
  const changed = new Set([...changes.added, ...changes.modified]);
  const scannedPaths: string[] = [];
  const findings: SkillSafetyFinding[] = [];
  for (const file of tree) {
    if (!changed.has(file.path) || !file.content || isBinary(file.content)) continue;
    scannedPaths.push(file.path);
    findings.push(...scanSkillText(file.path, file.content.toString('utf8')));
  }
  return scannedPaths.length ? summarizeSkillScan(scannedPaths, findings) : undefined;
}

/** 手动全量扫描：当前 `.agents/skills/` 目录内所有文本文件（不触发记版、不写盘）。 */
export function scanSkillsSafety(cwd: string): SkillScanReport {
  const tree = scanSkillsTree(cwd);
  const scannedPaths: string[] = [];
  const findings: SkillSafetyFinding[] = [];
  for (const file of tree) {
    if (!file.content || isBinary(file.content)) continue;
    scannedPaths.push(file.path);
    findings.push(...scanSkillText(file.path, file.content.toString('utf8')));
  }
  return {
    ...summarizeSkillScan(scannedPaths, findings),
    scannedAt: new Date().toISOString(),
    totalFiles: tree.length,
  };
}

/** Tolerantly parses the optional scan block; a malformed block is dropped, never fatal. */
function readScanSummary(value: unknown): SkillScanSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scan = value as Partial<SkillScanSummary>;
  if (!Array.isArray(scan.scannedPaths) || !Array.isArray(scan.findings)) return undefined;
  const scannedPaths = scan.scannedPaths.filter(
    (path): path is string => typeof path === 'string',
  );
  const findings: SkillSafetyFinding[] = [];
  for (const entry of scan.findings) {
    if (!entry || typeof entry !== 'object') continue;
    const finding = entry as Partial<SkillSafetyFinding>;
    if (
      typeof finding.ruleId !== 'string' ||
      (finding.severity !== 'critical' &&
        finding.severity !== 'warning' &&
        finding.severity !== 'info') ||
      typeof finding.path !== 'string' ||
      typeof finding.line !== 'number' ||
      typeof finding.message !== 'string'
    )
      continue;
    findings.push({
      ruleId: finding.ruleId,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      message: finding.message,
    });
  }
  const counts = { critical: 0, warning: 0, info: 0 };
  // counts 以存储值为准（findings 可能被截断），缺失时按明细重算。
  const stored = scan.counts;
  if (
    stored &&
    typeof stored.critical === 'number' &&
    typeof stored.warning === 'number' &&
    typeof stored.info === 'number'
  ) {
    counts.critical = stored.critical;
    counts.warning = stored.warning;
    counts.info = stored.info;
  } else {
    for (const finding of findings) counts[finding.severity] += 1;
  }
  return {
    scannedPaths,
    findings,
    counts,
    level:
      counts.critical > 0
        ? 'critical'
        : counts.warning > 0
          ? 'warning'
          : counts.info > 0
            ? 'info'
            : 'clean',
    ...(scan.truncated === true ? { truncated: true } : {}),
  };
}

function readManifest(directory: string): SkillVersionManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Partial<
      SkillVersionManifest & { files: unknown }
    >;
    if (
      typeof parsed.id !== 'string' ||
      !VERSION_ID_REGEX.test(parsed.id) ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.fingerprint !== 'string' ||
      !Array.isArray(parsed.files) ||
      (parsed.trigger !== 'manual' && parsed.trigger !== 'auto' && parsed.trigger !== 'rollback')
    )
      return undefined;
    const files: SkillVersionFileEntry[] = [];
    for (const entry of parsed.files) {
      if (!entry || typeof entry !== 'object') return undefined;
      const file = entry as Partial<SkillVersionFileEntry>;
      if (
        typeof file.path !== 'string' ||
        !isSafeRelativePath(file.path) ||
        typeof file.sha256 !== 'string' ||
        typeof file.size !== 'number'
      )
        return undefined;
      files.push({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        archived: file.archived !== false,
      });
    }
    const changes = parsed.changes;
    const scan = readScanSummary(parsed.scan);
    return {
      id: parsed.id,
      createdAt: parsed.createdAt,
      ...(typeof parsed.label === 'string' && parsed.label ? { label: parsed.label } : {}),
      trigger: parsed.trigger,
      fingerprint: parsed.fingerprint,
      files,
      changes:
        changes &&
        Array.isArray(changes.added) &&
        Array.isArray(changes.modified) &&
        Array.isArray(changes.deleted)
          ? { added: changes.added, modified: changes.modified, deleted: changes.deleted }
          : { added: [], modified: [], deleted: [] },
      ...(scan ? { scan } : {}),
    };
  } catch {
    return undefined;
  }
}

function listManifests(cwd: string): SkillVersionManifest[] {
  const root = versionsRoot(cwd);
  if (!existsSync(root)) return [];
  const manifests: SkillVersionManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VERSION_ID_REGEX.test(entry.name)) continue;
    const manifest = readManifest(join(root, entry.name));
    if (manifest && manifest.id === entry.name) manifests.push(manifest);
  }
  return manifests.sort((a, b) => a.id.localeCompare(b.id));
}

function toSummary(manifest: SkillVersionManifest) {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    ...(manifest.label ? { label: manifest.label } : {}),
    trigger: manifest.trigger,
    fingerprint: manifest.fingerprint,
    fileCount: manifest.files.length,
    changes: manifest.changes,
    ...(manifest.scan ? { scan: manifest.scan } : {}),
  };
}

function toDetail(manifest: SkillVersionManifest): SkillVersionDetail {
  return { ...toSummary(manifest), files: manifest.files };
}

function readArchivedFiles(cwd: string, manifest: SkillVersionManifest): Map<string, Buffer> {
  const contents = new Map<string, Buffer>();
  const root = versionsRoot(cwd);
  for (const file of manifest.files) {
    if (!file.archived) continue;
    const target = join(root, manifest.id, 'files', ...file.path.split('/'));
    try {
      if (!lstatSync(target).isFile()) continue;
      contents.set(file.path, readFileSync(target));
    } catch {
      // A missing archive file degrades that entry to "content unavailable".
    }
  }
  return contents;
}

/** Creates a version; returns the latest one unchanged when the tree has not drifted. */
export function createSkillSnapshot(
  cwd: string,
  options: { label?: string; trigger: SkillVersionTrigger },
): { version: SkillVersionDetail; created: boolean } {
  const tree = scanSkillsTree(cwd);
  const fingerprint = fingerprintOf(tree);
  const manifests = listManifests(cwd);
  const latest = manifests.at(-1);
  if (latest && latest.fingerprint === fingerprint)
    return { version: toDetail(latest), created: false };

  const changes = computeChanges(latest?.files ?? [], tree);
  // 入站面钩子：对新增/修改的文本文件做安全扫描，结果随 manifest 归档（只报告不拦截）。
  const scan = scanChangedFiles(tree, changes);

  const root = versionsRoot(cwd);
  mkdirSync(root, { recursive: true });
  let max = 0;
  for (const manifest of manifests) max = Math.max(max, Number(VERSION_ID_REGEX.exec(manifest.id)![1]));
  let id = '';
  let directory = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    id = `v${String(max + 1 + attempt).padStart(6, '0')}`;
    directory = join(root, id);
    try {
      mkdirSync(directory);
      break;
    } catch {
      if (attempt === 99) throw new Error('无法分配技能版本号');
    }
  }
  try {
    for (const file of tree) {
      if (!file.archived || !file.content) continue;
      const target = join(directory, 'files', ...file.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    const manifest: SkillVersionManifest = {
      id,
      createdAt: new Date().toISOString(),
      ...(options.label?.trim() ? { label: options.label.trim().slice(0, 200) } : {}),
      trigger: options.trigger,
      fingerprint,
      files: tree.map(({ content: _content, ...entry }) => entry),
      changes,
      ...(scan ? { scan } : {}),
    };
    // The manifest is written last so a half-written version never lists as valid.
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { version: toDetail(manifest), created: true };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Lazy auto-versioning hook for read requests: records a version only on drift. */
export function ensureSkillSnapshotFresh(cwd: string): SkillVersionDetail | undefined {
  const result = createSkillSnapshot(cwd, { trigger: 'auto' });
  return result.created ? result.version : undefined;
}

export function listSkillVersions(cwd: string): SkillVersionDetail[] {
  return listManifests(cwd).map(toDetail);
}

export function getSkillVersion(cwd: string, id: string): SkillVersionDetail | undefined {
  if (!VERSION_ID_REGEX.test(id)) return undefined;
  const manifest = readManifest(join(versionsRoot(cwd), id));
  return manifest && manifest.id === id ? toDetail(manifest) : undefined;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type DiffOp = { type: 'context' | 'del' | 'add'; text: string };

function lcsOps(a: string[], b: string[]): DiffOp[] {
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      ops.push({ type: 'del', text: a[i]! });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: 'del', text: a[i++]! });
  while (j < b.length) ops.push({ type: 'add', text: b[j++]! });
  return ops;
}

/** Minimal unified diff (3 lines of context); no git dependency. */
export function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
): string {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [
      `--- ${oldLabel}`,
      `+++ ${newLabel}`,
      `@@ -1,${a.length} +1,${b.length} @@`,
      ...a.map((line) => `-${line}`),
      ...b.map((line) => `+${line}`),
    ].join('\n');
  }
  const ops = lcsOps(a, b);
  const tagged: (DiffOp & { a: number; b: number })[] = [];
  let lineA = 1;
  let lineB = 1;
  for (const op of ops) {
    tagged.push({ ...op, a: op.type === 'add' ? 0 : lineA, b: op.type === 'del' ? 0 : lineB });
    if (op.type !== 'add') lineA += 1;
    if (op.type !== 'del') lineB += 1;
  }
  const changed = tagged.flatMap((op, index) => (op.type === 'context' ? [] : [index]));
  if (!changed.length) return '';
  const hunks: [number, number][] = [];
  let start = changed[0]!;
  let previous = changed[0]!;
  for (const index of changed.slice(1)) {
    if (index - previous > DIFF_CONTEXT_LINES * 2) {
      hunks.push([start, previous]);
      start = index;
    }
    previous = index;
  }
  hunks.push([start, previous]);
  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [from, to] of hunks) {
    const slice = tagged.slice(
      Math.max(0, from - DIFF_CONTEXT_LINES),
      Math.min(tagged.length, to + DIFF_CONTEXT_LINES + 1),
    );
    const aStart = slice.find((op) => op.a > 0)?.a ?? 0;
    const bStart = slice.find((op) => op.b > 0)?.b ?? 0;
    const aCount = slice.filter((op) => op.type !== 'add').length;
    const bCount = slice.filter((op) => op.type !== 'del').length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice)
      out.push(`${op.type === 'context' ? ' ' : op.type === 'del' ? '-' : '+'}${op.text}`);
  }
  return out.join('\n');
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

interface DiffSide {
  label: string;
  files: Map<string, { sha256: string; size: number; content?: Buffer }>;
}

function versionSide(cwd: string, id: string): DiffSide {
  const manifest = readManifest(join(versionsRoot(cwd), id));
  if (!manifest || manifest.id !== id) throw new SkillVersionNotFoundError(id);
  const archived = readArchivedFiles(cwd, manifest);
  return {
    label: id,
    files: new Map(
      manifest.files.map((file) => [
        file.path,
        {
          sha256: file.sha256,
          size: file.size,
          ...(archived.has(file.path) ? { content: archived.get(file.path)! } : {}),
        },
      ]),
    ),
  };
}

function currentSide(cwd: string): DiffSide {
  const tree = scanSkillsTree(cwd);
  return {
    label: 'current',
    files: new Map(
      tree.map((file) => [
        file.path,
        { sha256: file.sha256, size: file.size, ...(file.content ? { content: file.content } : {}) },
      ]),
    ),
  };
}

/** Diffs two versions; `to` may be the literal `current` for the live tree. */
export function diffSkillVersions(
  cwd: string,
  fromId: string,
  toId: string,
): { from: string; to: string; files: SkillDiffFileChange[] } {
  if (!VERSION_ID_REGEX.test(fromId)) throw new SkillVersionNotFoundError(fromId);
  const from = versionSide(cwd, fromId);
  const to = toId === 'current' ? currentSide(cwd) : versionSide(cwd, toId);
  const files: SkillDiffFileChange[] = [];
  const paths = [...new Set([...from.files.keys(), ...to.files.keys()])].sort();
  for (const path of paths) {
    const before = from.files.get(path);
    const after = to.files.get(path);
    if (before && after && before.sha256 === after.sha256) continue;
    const status = !before ? 'added' : !after ? 'deleted' : 'modified';
    const entry: SkillDiffFileChange = { path, status };
    const oldContent = before?.content;
    const newContent = after?.content;
    if ((before && !oldContent) || (after && !newContent)) {
      entry.note = '内容未归档（超过 1MB），仅指纹可比对';
    } else if ((oldContent && isBinary(oldContent)) || (newContent && isBinary(newContent))) {
      entry.note = `二进制文件（${before?.size ?? 0} → ${after?.size ?? 0} 字节）`;
    } else {
      entry.diff = unifiedDiff(
        oldContent?.toString('utf8') ?? '',
        newContent?.toString('utf8') ?? '',
        `a/${path}`,
        `b/${path}`,
      );
    }
    files.push(entry);
  }
  return { from: fromId, to: toId, files };
}

/** Compares the live tree against a version; pure read, never writes. */
export function planSkillRollback(
  cwd: string,
  versionId: string,
): { versionId: string; plan: SkillRollbackPlan } {
  const version = getSkillVersion(cwd, versionId);
  if (!version) throw new SkillVersionNotFoundError(versionId);
  const live = scanSkillsTree(cwd);
  const liveByPath = new Map(live.map((file) => [file.path, file.sha256]));
  const snapshotPaths = new Set(version.files.map((file) => file.path));
  const restore: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const file of version.files) {
    const liveHash = liveByPath.get(file.path);
    if (liveHash === file.sha256) continue;
    if (!file.archived) {
      skipped.push({ path: file.path, reason: '快照未归档该文件内容（超过 1MB），无法恢复' });
      continue;
    }
    restore.push(file.path);
  }
  const deleted = live
    .filter((file) => !snapshotPaths.has(file.path))
    .map((file) => file.path)
    .sort();
  restore.sort();
  return {
    versionId,
    plan: {
      restore,
      delete: deleted,
      unchanged: version.files.length - restore.length - skipped.length,
      skipped,
      upToDate: restore.length === 0 && deleted.length === 0,
    },
  };
}

function assertWriteTargetSafe(cwd: string, path: string): string {
  if (!isSafeRelativePath(path)) throw new Error(`回滚路径不合法：${path}`);
  const root = join(cwd, SKILLS_DIR);
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);
  if (!isWithin(realpathSync(cwd), realRoot)) throw new Error('技能目录逃逸工作区');
  const target = resolve(realRoot, ...path.split('/'));
  if (!isWithin(realRoot, target)) throw new Error(`回滚路径逃逸技能目录：${path}`);
  let current = realRoot;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`回滚路径经过符号链接，拒绝写入：${path}`);
  }
  return target;
}

/**
 * Restores the live tree to a version: archived contents are written back and files
 * added after the snapshot are deleted. The current state is snapshotted first
 * (trigger 'rollback') so the rollback itself is reversible.
 */
export function applySkillRollback(
  cwd: string,
  versionId: string,
  reason?: string,
): { versionId: string; plan: SkillRollbackPlan; preSnapshotId?: string } {
  const { plan } = planSkillRollback(cwd, versionId);
  if (plan.upToDate) return { versionId, plan };
  const pre = createSkillSnapshot(cwd, {
    trigger: 'rollback',
    label: `回滚至 ${versionId} 前自动快照${reason?.trim() ? `（${reason.trim().slice(0, 120)}）` : ''}`,
  });
  const manifest = readManifest(join(versionsRoot(cwd), versionId))!;
  const archived = readArchivedFiles(cwd, manifest);
  for (const path of plan.restore) {
    const content = archived.get(path);
    if (!content) continue;
    const target = assertWriteTargetSafe(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const root = join(cwd, SKILLS_DIR);
  const realRoot = realpathSync(root);
  for (const path of plan.delete) {
    const target = assertWriteTargetSafe(cwd, path);
    if (!existsSync(target)) continue;
    const stats = lstatSync(target);
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    rmSync(target);
    // Prune directories left empty, never above the skills root.
    let directory = dirname(target);
    while (directory !== realRoot && isWithin(realRoot, directory)) {
      try {
        rmdirSync(directory);
      } catch {
        break;
      }
      directory = dirname(directory);
    }
  }
  return { versionId, plan, preSnapshotId: pre.version.id };
}
