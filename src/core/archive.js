// 归档解包（zip / tar.gz）：零依赖实现，供远程订阅源下载归档用。
//
// zip 解包移植自 vercel-labs/skills（https://github.com/vercel-labs/skills，
// MIT License，src/archive.ts），按本仓库 ESM/JS 风格改写；tar 解包为本仓库
// 自写的 ustar/GNU-longname 读取器（tar 是 512 字节块的简单格式，不值得引依赖）。
//
// 安全边界（与 skills CLI 同款思路）：
// - maxEntries / maxExtractedBytes 由调用方传入，超限抛错而不是默默解到底
// - 条目路径一律过 normalizeArchivePath：拒绝绝对路径、盘符、.. 穿越与 NUL
// - zip 拒绝加密条目与链接条目；tar 拒绝 symlink/hardlink 条目——
//   订阅源是外部输入，链接落地会指向任意本机路径
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const ZIP_END_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 0xffff;
const CP437_HIGH_BYTES = [
  'ÇüéâäàåçêëèïîìÄÅ',
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ',
  'áíóúñÑªº¿⌐¬½¼¡«»',
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐',
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧',
  '╨╤╥╙╘╒╓╫╪┘▄▌▐▀',
  'αßΓπΣσµτΦΘΩδ∞φε∩',
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
].join('');

export class ArchiveValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

function ensureRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error('Invalid zip archive: ' + label + ' is out of bounds');
  }
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - ZIP_MAX_COMMENT_SIZE - ZIP_END_MIN_SIZE);
  for (let offset = buffer.length - ZIP_END_MIN_SIZE; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;

    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + ZIP_END_MIN_SIZE + commentLength === buffer.length) {
      return offset;
    }
  }
  return -1;
}

function readUInt64AsNumber(buffer, offset, label) {
  ensureRange(buffer, offset, 8, label);
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid zip archive: ' + label + ' exceeds the safe integer range');
  }
  return Number(value);
}

function readCentralDirectory(buffer, endOffset) {
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const size = buffer.readUInt32LE(endOffset + 12);
  const offset = buffer.readUInt32LE(endOffset + 16);
  const usesZip64 =
    entriesOnDisk === 0xffff ||
    totalEntries === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff;

  if (!usesZip64) {
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new Error('Multi-disk zip archives are not supported');
    }
    return { entries: totalEntries, offset, size, trailerOffset: endOffset };
  }

  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new Error('Multi-disk zip archives are not supported');
  }

  const locatorOffset = endOffset - 20;
  ensureRange(buffer, locatorOffset, 20, 'zip64 locator');
  if (buffer.readUInt32LE(locatorOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
    throw new Error('Invalid zip64 locator');
  }
  if (
    buffer.readUInt32LE(locatorOffset + 4) !== 0 ||
    buffer.readUInt32LE(locatorOffset + 16) !== 1
  ) {
    throw new Error('Multi-disk zip archives are not supported');
  }

  const zip64EndOffset = readUInt64AsNumber(buffer, locatorOffset + 8, 'zip64 end offset');
  ensureRange(buffer, zip64EndOffset, 56, 'zip64 end of central directory');
  if (buffer.readUInt32LE(zip64EndOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
    throw new Error('Invalid zip64 end of central directory');
  }

  const recordSize = readUInt64AsNumber(buffer, zip64EndOffset + 4, 'zip64 end size');
  if (recordSize < 44) {
    throw new Error('Invalid zip64 end of central directory');
  }
  ensureRange(buffer, zip64EndOffset, recordSize + 12, 'zip64 end of central directory');
  if (zip64EndOffset + recordSize + 12 !== locatorOffset) {
    throw new Error('Invalid zip64 end of central directory');
  }
  if (
    buffer.readUInt32LE(zip64EndOffset + 16) !== 0 ||
    buffer.readUInt32LE(zip64EndOffset + 20) !== 0
  ) {
    throw new Error('Multi-disk zip archives are not supported');
  }

  const zip64EntriesOnDisk = readUInt64AsNumber(buffer, zip64EndOffset + 24, 'zip64 entries on disk');
  const zip64TotalEntries = readUInt64AsNumber(buffer, zip64EndOffset + 32, 'zip64 total entries');
  if (zip64EntriesOnDisk !== zip64TotalEntries) {
    throw new Error('Multi-disk zip archives are not supported');
  }

  return {
    entries: zip64TotalEntries,
    size: readUInt64AsNumber(buffer, zip64EndOffset + 40, 'zip64 central directory size'),
    offset: readUInt64AsNumber(buffer, zip64EndOffset + 48, 'zip64 central directory offset'),
    trailerOffset: zip64EndOffset,
  };
}

// 条目路径白名单化：返回归一化路径，或 null（表示不安全，调用方应拒绝整个归档）。
// zip 与 tar 共用——两种格式落地的是同一批外部文件，规则必须一致。
export function normalizeArchivePath(rawPath) {
  if (!rawPath || rawPath.includes('\0')) return null;

  const path = rawPath.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;

  const parts = path.split('/');
  if (parts.some((part) => part === '..')) return null;

  const normalized = parts.filter((part) => part && part !== '.').join('/');
  if (!normalized && !path.endsWith('/')) return null;
  return path.endsWith('/') && normalized ? normalized + '/' : normalized;
}

function findExtraField(buffer, extraOffset, extraLength, targetId) {
  const extraEnd = extraOffset + extraLength;
  let offset = extraOffset;
  while (offset < extraEnd) {
    if (offset + 4 > extraEnd) throw new Error('Invalid zip extra field');

    const id = buffer.readUInt16LE(offset);
    const size = buffer.readUInt16LE(offset + 2);
    const dataOffset = offset + 4;
    ensureRange(buffer, dataOffset, size, 'zip extra field');
    if (dataOffset + size > extraEnd) throw new Error('Invalid zip extra field');
    if (id === targetId) return buffer.subarray(dataOffset, dataOffset + size);

    offset = dataOffset + size;
  }
  return null;
}

function decodeFileName(bytes, isUtf8, unicodePathExtra) {
  if (isUtf8) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  if (
    unicodePathExtra &&
    unicodePathExtra.length >= 5 &&
    unicodePathExtra[0] === 1 &&
    unicodePathExtra.readUInt32LE(1) === crc32(bytes)
  ) {
    return new TextDecoder('utf-8', { fatal: true }).decode(unicodePathExtra.subarray(5));
  }

  let result = '';
  for (const byte of bytes) {
    result += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH_BYTES[byte - 0x80];
  }
  return result;
}

function readZip64EntryValues(buffer, extraOffset, extraLength, values) {
  const needsZip64 =
    values.uncompressedSize === 0xffffffff ||
    values.compressedSize === 0xffffffff ||
    values.localHeaderOffset === 0xffffffff ||
    values.diskStart === 0xffff;

  if (!needsZip64) {
    if (values.diskStart !== 0) throw new Error('Multi-disk zip archives are not supported');
    return values;
  }

  const zip64Extra = findExtraField(buffer, extraOffset, extraLength, 0x0001);
  if (!zip64Extra) throw new Error('Invalid zip64 extra field');

  let valueOffset = 0;
  const readNextUInt64 = (label) => {
    if (valueOffset + 8 > zip64Extra.length) {
      throw new Error('Invalid zip64 extra field: missing ' + label);
    }
    const value = readUInt64AsNumber(zip64Extra, valueOffset, 'zip64 ' + label);
    valueOffset += 8;
    return value;
  };

  const resolved = { ...values };
  if (resolved.uncompressedSize === 0xffffffff) {
    resolved.uncompressedSize = readNextUInt64('uncompressed size');
  }
  if (resolved.compressedSize === 0xffffffff) {
    resolved.compressedSize = readNextUInt64('compressed size');
  }
  if (resolved.localHeaderOffset === 0xffffffff) {
    resolved.localHeaderOffset = readNextUInt64('local header offset');
  }
  if (resolved.diskStart === 0xffff) {
    if (valueOffset + 4 > zip64Extra.length) {
      throw new Error('Invalid zip64 extra field: missing disk start');
    }
    resolved.diskStart = zip64Extra.readUInt32LE(valueOffset);
  }
  if (resolved.diskStart !== 0) {
    throw new Error('Multi-disk zip archives are not supported');
  }
  return resolved;
}

// 解包 zip：返回 Map<归一化路径, Uint8Array>（目录条目不进 Map）。
export function readZipArchive(bytes, limits) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(buffer);
  if (endOffset < 0) throw new Error('Invalid zip archive');

  const centralDirectory = readCentralDirectory(buffer, endOffset);
  const totalEntries = centralDirectory.entries;
  if (totalEntries > limits.maxEntries) {
    throw new ArchiveValidationError(
      'Archive contains too many files (' + totalEntries + '). Maximum is ' + limits.maxEntries + '.'
    );
  }

  ensureRange(buffer, centralDirectory.offset, centralDirectory.size, 'central directory');
  if (centralDirectory.offset + centralDirectory.size > centralDirectory.trailerOffset) {
    throw new Error('Invalid zip archive: central directory overlaps archive trailer');
  }

  const files = new Map();
  let extractedBytes = 0;
  let offset = centralDirectory.offset;

  for (let index = 0; index < totalEntries; index++) {
    ensureRange(buffer, offset, 46, 'central directory entry');
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('Invalid zip central directory entry');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedChecksum = buffer.readUInt32LE(offset + 16);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    let localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const variableSize = fileNameLength + extraLength + commentLength;
    ensureRange(buffer, offset + 46, variableSize, 'central directory entry data');

    const nameStart = offset + 46;
    const extraOffset = nameStart + fileNameLength;
    ({ compressedSize, diskStart, localHeaderOffset, uncompressedSize } = readZip64EntryValues(
      buffer,
      extraOffset,
      extraLength,
      {
        compressedSize,
        diskStart,
        localHeaderOffset,
        uncompressedSize,
      }
    ));
    const centralFileName = buffer.subarray(nameStart, nameStart + fileNameLength);
    const rawFileName = decodeFileName(
      centralFileName,
      Boolean(flags & 0x800),
      findExtraField(buffer, extraOffset, extraLength, 0x7075)
    );
    const fileName = normalizeArchivePath(rawFileName);
    if (fileName === null) {
      throw new ArchiveValidationError('Archive contains unsafe path: ' + rawFileName);
    }
    if (flags & 0x1) {
      throw new ArchiveValidationError('Encrypted zip entries are not supported');
    }
    const fileType = (externalAttributes >>> 16) & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      throw new ArchiveValidationError('Archive links are not supported');
    }
    const isDirectory = rawFileName.replace(/\\/g, '/').endsWith('/') || fileType === 0o040000;
    offset += 46 + variableSize;

    extractedBytes += uncompressedSize;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new ArchiveValidationError(
        'Archive extracts to more than ' + limits.maxExtractedBytes + ' bytes.'
      );
    }
    if (isDirectory) continue;

    ensureRange(buffer, localHeaderOffset, 30, 'local file header');
    if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error('Invalid zip local file header');
    }

    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const localNameOffset = localHeaderOffset + 30;
    ensureRange(
      buffer,
      localNameOffset,
      localFileNameLength + localExtraLength,
      'local file header data'
    );
    const localFileName = buffer.subarray(localNameOffset, localNameOffset + localFileNameLength);
    if (localFlags !== flags || localMethod !== method || !localFileName.equals(centralFileName)) {
      throw new Error('Zip local header does not match central directory');
    }

    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    ensureRange(buffer, dataOffset, compressedSize, 'file data');
    if (dataOffset + compressedSize > centralDirectory.offset) {
      throw new Error('Invalid zip archive: file data overlaps central directory');
    }

    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let contents;
    if (method === 0) {
      contents = compressed;
    } else if (method === 8) {
      contents = inflateRawSync(compressed, {
        maxOutputLength: uncompressedSize + 1,
      });
    } else {
      throw new Error('Unsupported zip compression method: ' + method);
    }

    if (contents.byteLength !== uncompressedSize) {
      throw new Error('Zip entry size mismatch');
    }
    if (crc32(contents) !== expectedChecksum) {
      throw new Error('Zip entry checksum mismatch');
    }
    // Buffer（而非 Uint8Array 视图）：值可能直接被 .toString() 当文本读
    files.set(fileName, Buffer.from(contents));
  }

  if (offset !== centralDirectory.offset + centralDirectory.size) {
    throw new Error('Invalid zip central directory size');
  }

  return files;
}

// ---- tar（含 gzip 外壳）--------------------------------------------------
// ustar/GNU 基础读取：512 字节头块 + 数据块补齐到 512 倍数，两块全零结尾。
// 只接受普通文件（'0'/NUL）与目录（'5'）；'L'（GNU longname）承载超长文件名，
// '1'/'2' 链接一律拒绝（同 zip 的链接拒绝，理由见文件头）。

function octal(field) {
  // 尺寸/时间字段是八进制 ASCII，可能以空格或 NUL 填充；GNU 有 base-256 扩展（高位置 1），
  // 订阅源场景用不到，遇到按不可解析处理。
  const raw = field.toString('latin1').replace(/[\0 ]/g, '');
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error('Invalid tar archive: non-octal size field');
  return parseInt(raw, 8);
}

export function readTarArchive(bytes, limits) {
  let buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = gunzipSync(buffer, { maxOutputLength: limits.maxExtractedBytes + 1 });
  }
  if (buffer.length % 512 !== 0) throw new Error('Invalid tar archive: size not a multiple of 512');

  const files = new Map();
  let extractedBytes = 0;
  let entries = 0;
  let offset = 0;
  let pendingLongName = ''; // 'L' 条目的数据是**下一个**条目的名字

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 结尾块（其后允许还有一块全零或截尾）

    const magic = header.toString('latin1', 257, 263);
    if (magic !== 'ustar\x00' && magic !== 'ustar ') {
      throw new Error('Invalid tar archive: bad magic at block ' + offset / 512);
    }
    const size = octal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156]);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;

    const dataStart = offset + 512;
    const dataLen = Math.ceil(size / 512) * 512;
    ensureRange(buffer, dataStart, dataLen, 'tar entry data');
    const data = buffer.subarray(dataStart, dataStart + size);

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
      offset = dataStart + dataLen;
      continue;
    }
    if (typeflag === 'K') {
      // longlink：只影响 linkname，而链接本来就要拒绝——读了扔掉即可
      offset = dataStart + dataLen;
      continue;
    }
    if (pendingLongName) {
      name = pendingLongName;
      pendingLongName = '';
    }

    entries += 1;
    if (entries > limits.maxEntries) {
      throw new ArchiveValidationError(
        'Archive contains too many files (' + entries + '). Maximum is ' + limits.maxEntries + '.'
      );
    }

    const fileName = normalizeArchivePath(name);
    if (fileName === null) {
      throw new ArchiveValidationError('Archive contains unsafe path: ' + name);
    }
    if (typeflag === '1' || typeflag === '2') {
      throw new ArchiveValidationError('Archive links are not supported');
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
      throw new Error('Unsupported tar entry type: ' + JSON.stringify(typeflag));
    }

    extractedBytes += size;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new ArchiveValidationError(
        'Archive extracts to more than ' + limits.maxExtractedBytes + ' bytes.'
      );
    }
    if (typeflag !== '5' && !fileName.endsWith('/')) {
      files.set(fileName, Buffer.from(data)); // data 是视图，拷出独立 Buffer
    }
    offset = dataStart + dataLen;
  }

  return files;
}

// 统一入口：按魔数分流 zip / tar(.gz)，调用方不关心格式。
export function readArchive(bytes, limits) {
  const head = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset || 0, Math.min(4, bytes.byteLength ?? bytes.length));
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return readTarArchive(bytes, limits);
  if (head.length >= 4 && head.readUInt32BE(0) === 0x504b0304) return readZipArchive(bytes, limits);
  throw new Error('Unsupported archive format (expected zip or tar.gz)');
}
