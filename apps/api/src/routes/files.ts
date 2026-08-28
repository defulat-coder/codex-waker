import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FileContentResponse, FileEntry, FileListResponse } from '@waker/contracts';
import { FileContentQuerySchema, FileListQuerySchema } from '../schemas.js';
import type { AppContext } from '../context.js';

const CONTENT_LIMIT_BYTES = 256 * 1024;
/** 始终拒绝的路径段：目录整棵隐藏，敏感文件不可列不可读。 */
const DENIED_SEGMENTS = new Set(['.git', 'node_modules']);
const DENIED_FILE_PATTERNS = [/^\.env$/, /\.pem$/i, /\.key$/i, /^id_rsa/];

function isDeniedName(name: string): boolean {
  return DENIED_SEGMENTS.has(name) || DENIED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

type ResolvedPath = { path: string; rel: string } | { status: 400 | 404 };

/**
 * 把 query 里的相对路径解析到仓库根内：拒绝绝对路径、`..` 逃逸与敏感文件段，
 * 再经 realpath 复核挡软链接逃逸。不存在 → 404，其余违规 → 400。
 */
async function resolveRequestPath(cwd: string, rawPath: string): Promise<ResolvedPath> {
  if (isAbsolute(rawPath)) return { status: 400 };
  const resolved = resolve(cwd, rawPath);
  const rel = relative(cwd, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { status: 400 };
  if (rel.split(sep).some(isDeniedName)) return { status: 400 };
  try {
    const [rootReal, targetReal] = await Promise.all([realpath(cwd), realpath(resolved)]);
    const realRel = relative(rootReal, targetReal);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel))
      return { status: 400 };
    // rel 用词法路径（cwd 可能未 realpath，不能拿 realpath 后的 target 反推展示路径）。
    return { path: targetReal, rel: rel.split(sep).join('/') };
  } catch {
    // realpath 失败 = 目标不存在（resolve 阶段已排除语法层面的逃逸）。
    return { status: 404 };
  }
}

/** 读文件前 bytes 字节（已知 size 超限时调用，避免整文件入内存）。 */
async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 严格 UTF-8 解码；截断点可能切断多字节字符，最多回退 3 字节重试。 */
function decodeUtf8(buffer: Buffer): string | undefined {
  for (let drop = 0; drop <= 3; drop += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, buffer.length - drop),
      );
    } catch {
      // 继续回退
    }
  }
  return undefined;
}

/** 只读项目文件浏览：目录列表与文本内容预览（Files 面板的数据源）。 */
export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { path?: string } }>(
    '/files',
    { schema: { querystring: FileListQuerySchema } },
    async (request, reply): Promise<FileListResponse | void> => {
      const rawPath = request.query.path ?? '';
      const target = await resolveRequestPath(ctx.cwd, rawPath);
      if ('status' in target)
        return reply
          .code(target.status)
          .send({ error: target.status === 404 ? '路径不存在' : '路径不合法' });
      const info = await stat(target.path);
      if (!info.isDirectory()) return reply.code(400).send({ error: '路径不是目录' });

      const dirents = await readdir(target.path, { withFileTypes: true });
      const entries: FileEntry[] = [];
      for (const dirent of dirents) {
        if (isDeniedName(dirent.name)) continue;
        // 软链接与特殊文件不列出（内容侧也被 realpath 复核挡住）。
        const kind = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : undefined;
        if (!kind) continue;
        let size = 0;
        if (kind === 'file') {
          try {
            size = (await stat(join(target.path, dirent.name))).size;
          } catch {
            continue; // 列出瞬间被删的文件直接跳过
          }
        }
        entries.push({ name: dirent.name, kind, size });
      }
      entries.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
      );
      return { path: target.rel, entries };
    },
  );

  app.get<{ Querystring: { path: string } }>(
    '/files/content',
    { schema: { querystring: FileContentQuerySchema } },
    async (request, reply): Promise<FileContentResponse | void> => {
      const target = await resolveRequestPath(ctx.cwd, request.query.path);
      if ('status' in target)
        return reply
          .code(target.status)
          .send({ error: target.status === 404 ? '路径不存在' : '路径不合法' });
      const info = await stat(target.path);
      if (!info.isFile()) return reply.code(400).send({ error: '路径不是文件' });

      const truncated = info.size > CONTENT_LIMIT_BYTES;
      const buffer = truncated
        ? await readPrefix(target.path, CONTENT_LIMIT_BYTES)
        : await readFile(target.path);
      const content = buffer.includes(0) ? undefined : decodeUtf8(buffer);
      if (content === undefined)
        return reply.code(415).send({ error: '二进制或不支持的编码，无法预览' });
      return { path: target.rel, content, truncated };
    },
  );
}
