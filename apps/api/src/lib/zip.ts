import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP container reader/writer on top of node:zlib raw deflate.
 * The dependency tree ships no zip library, so the Agent 整包 endpoints use
 * this small implementation instead of adding one. Only what the package
 * contract needs: method 0/8 entries, no zip64, no encryption, sizes and CRC
 * always read from the central directory.
 */

export interface ZipEntryInput {
  path: string;
  data: Buffer;
}

export interface ZipEntry {
  path: string;
  data: Buffer;
}

export interface UnzipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

// --- CRC32 (IEEE, table-driven) ------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Writer ----------------------------------------------------------------------

/** Fixed DOS timestamp (2024-01-01 00:00) so exports are byte-stable for identical content. */
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

export function zipEntries(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 9 });
    // Store entries that do not compress; readers handle both methods.
    const useDeflate = compressed.length < entry.data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? compressed : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, name);

    offset += 30 + name.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // central disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, centralDirectory, end]);
}

// --- Reader ----------------------------------------------------------------------

function findEndOfCentralDirectory(data: Buffer): number {
  // EOCD is 22 bytes plus an up-to-64KB comment; scan backwards for the signature.
  const window = Math.min(data.length, 22 + 0xffff);
  for (let position = data.length - 22; position >= data.length - window; position -= 1) {
    if (data.readUInt32LE(position) === 0x06054b50) return position;
  }
  throw new ZipError('不是合法的 ZIP 包（缺少中央目录结尾记录）');
}

/**
 * Parses a ZIP buffer into file entries. Directory entries are skipped; every
 * file entry is CRC-checked. Throws ZipError on malformed input or limit
 * violations — callers map that to a 400.
 */
export function unzipEntries(data: Buffer, limits: UnzipLimits): ZipEntry[] {
  if (data.length < 22) throw new ZipError('不是合法的 ZIP 包');
  const eocd = findEndOfCentralDirectory(data);
  const entryCount = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('不支持 ZIP64 格式的包');
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError(`ZIP 条目数超过上限 ${limits.maxEntries}`);
  }
  if (centralOffset + centralSize > data.length) throw new ZipError('ZIP 中央目录越界');

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ZipError('ZIP 中央目录损坏');
    }
    const method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const path = data.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith('/')) continue; // 目录条目不携带内容
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipError('不支持 ZIP64 格式的包');
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ZipError(`ZIP 条目超过大小上限：${path}`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ZipError(`ZIP 解压总大小超过上限 ${limits.maxTotalBytes}`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(`不支持的压缩方式（method ${method}）：${path}`);
    }
    // 数据位置以本地头为准（本地头的 name/extra 长度可能与中央目录不同）。
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`ZIP 本地文件头损坏：${path}`);
    }
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > data.length) throw new ZipError(`ZIP 条目数据越界：${path}`);
    const payload = data.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    try {
      content = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    } catch {
      throw new ZipError(`ZIP 条目解压失败：${path}`);
    }
    if (content.length !== uncompressedSize || crc32(content) !== crc) {
      throw new ZipError(`ZIP 条目校验失败：${path}`);
    }
    entries.push({ path, data: content });
  }
  return entries;
}
