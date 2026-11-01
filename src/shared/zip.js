/**
 * ZIP files, for the web app's backups (src/web/backup.js): writing one of
 * Blobs, and reading one the user picked, which may come from anywhere.
 *
 * Writing stores the entries as they are, without compressing them, since
 * PDFs mostly are compressed already, with ZIP64 records where sizes or
 * offsets pass 4 GiB. The ZIP is a Blob of the entries' own Blobs and the
 * headers between them, so making it never holds a document in memory. Each
 * entry's CRC-32 comes from reading it CHUNK_SIZE at a time.
 *
 * Reading takes stored and deflated entries, the latter through
 * `DecompressionStream("deflate-raw")`, so that a backup that another app
 * zipped again still imports. It checks every offset and size against the
 * file before using it, refuses entries that overlap or lie outside it, and
 * checks each entry's size and CRC-32 as it's read. Encrypted entries can't
 * be read.
 *
 * Free of Electron and Node, in src/shared/, so that unit tests run it under
 * plain Node, which has Blob and DecompressionStream too.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/** The ZIP64 extra field's id. */
const ZIP64_EXTRA = 0x0001;

/** What a 16-bit or 32-bit field holds when ZIP64 has the value. */
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

/** Bit 0 of the flags: encrypted. Bit 11: the name is UTF-8. */
const ENCRYPTED = 0x0001;
const UTF8 = 0x0800;

/** The version a reader needs: 2.0 for stored entries, 4.5 for ZIP64. */
const VERSION = 20;
const VERSION_ZIP64 = 45;

/** The methods: stored, and deflated. */
const STORED = 0;
const DEFLATED = 8;

/** How much is read at a time, for a CRC-32. */
const CHUNK_SIZE = 1024 * 1024;

/** More entries than any backup has. */
export const MAX_ENTRIES = 100_000;

/** More than any backup's central directory takes. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

/** The end of central directory record, and the most its comment takes. */
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;

/**
 * @typedef {object} BlobLike a Blob, or what tests make look like one
 * @property {number} size
 * @property {(start?: number, end?: number) => BlobLike} slice
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 * @property {() => ReadableStream<Uint8Array>} stream
 */

/**
 * @typedef {object} ZipInput an entry to write
 * @property {string} name its path in the ZIP, with `/`
 * @property {BlobLike} blob
 * @property {Date} [modified] when it last changed, now by default
 * @property {number} [crc32] its CRC-32, if it's known already
 */

/**
 * @typedef {object} ZipEntry an entry of a ZIP that was read
 * @property {string} name its path, with `/`
 * @property {number} method 0 stored, 8 deflated, or another the reader refuses
 * @property {boolean} encrypted
 * @property {number} crc32
 * @property {number} compressedSize
 * @property {number} size
 * @property {number} offset where its data starts in the ZIP
 */

/**
 * @typedef {"not-zip" | "damaged" | "encrypted" | "unsupported" | "too-large" | "checksum"} ZipErrorReason
 */

/** A ZIP that can't be read, or an entry of one. */
export class ZipError extends Error {
  /**
   * @param {ZipErrorReason} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = "ZipError";
    this.reason = reason;
  }
}

/** @type {Uint32Array | null} */
let crcTable = null;

/**
 * @param {Uint8Array} bytes
 * @param {number} [crc] the CRC-32 of what came before
 * @returns {number} the CRC-32 of what came before and `bytes`
 */
export function crc32(bytes, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * @param {BlobLike} blob
 * @param {{ signal?: AbortSignal, onRead?: (bytes: number) => void }} [options]
 * @returns {Promise<number>} its CRC-32, read CHUNK_SIZE at a time
 */
export async function crc32Of(blob, { signal, onRead } = {}) {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
    signal?.throwIfAborted();
    const chunk = new Uint8Array(await blob.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    crc = crc32(chunk, crc);
    onRead?.(chunk.length);
  }
  return crc;
}

/**
 * The parts of a ZIP of `entries`, stored: the headers as bytes, and the
 * entries' own blobs between them.
 *
 * @param {ZipInput[]} entries
 * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
 *   onProgress hears how many bytes of the entries have been read for their
 *   CRC-32s
 * @returns {Promise<(Uint8Array | BlobLike)[]>}
 */
export async function zipParts(entries, { signal, onProgress } = {}) {
  const encoder = new TextEncoder();
  const total = entries.reduce((sum, { blob, crc32: known }) => sum + (known === undefined ? blob.size : 0), 0);
  let done = 0;
  /** @type {(Uint8Array | BlobLike)[]} */
  const parts = [];
  /** @type {Uint8Array[]} */
  const directory = [];
  let offset = 0;
  let zip64 = entries.length >= MAX16;

  for (const { name, blob, modified = new Date(), crc32: known } of entries) {
    const nameBytes = encoder.encode(name);
    if (nameBytes.length === 0 || nameBytes.length > MAX16) throw new Error(`Can't zip an entry named "${name}"`);
    const crc =
      known ??
      (await crc32Of(blob, {
        signal,
        onRead: (bytes) => onProgress?.((done += bytes), total),
      }));
    const { size } = blob;
    const [time, date] = dosTime(modified);
    const large = size >= MAX32;
    const far = offset >= MAX32;
    if (large || far) zip64 = true;

    const local = new Writer(30 + nameBytes.length + (large ? 20 : 0));
    local.u32(LOCAL_HEADER);
    local.u16(large ? VERSION_ZIP64 : VERSION);
    local.u16(UTF8);
    local.u16(STORED);
    local.u16(time);
    local.u16(date);
    local.u32(crc);
    local.u32(large ? MAX32 : size);
    local.u32(large ? MAX32 : size);
    local.u16(nameBytes.length);
    local.u16(large ? 20 : 0);
    local.bytes(nameBytes);
    if (large) {
      local.u16(ZIP64_EXTRA);
      local.u16(16);
      local.u64(size);
      local.u64(size);
    }

    // In the central directory, ZIP64's extra field holds just the values
    // too large for their own fields, in this order.
    const extra = [...(large ? [size, size] : []), ...(far ? [offset] : [])];
    const extraSize = extra.length > 0 ? 4 + 8 * extra.length : 0;
    const central = new Writer(46 + nameBytes.length + extraSize);
    central.u32(CENTRAL_HEADER);
    central.u16(VERSION_ZIP64);
    central.u16(large || far ? VERSION_ZIP64 : VERSION);
    central.u16(UTF8);
    central.u16(STORED);
    central.u16(time);
    central.u16(date);
    central.u32(crc);
    central.u32(large ? MAX32 : size);
    central.u32(large ? MAX32 : size);
    central.u16(nameBytes.length);
    central.u16(extraSize);
    central.u16(0); // comment
    central.u16(0); // disk
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(far ? MAX32 : offset);
    central.bytes(nameBytes);
    if (extraSize > 0) {
      central.u16(ZIP64_EXTRA);
      central.u16(8 * extra.length);
      for (const value of extra) central.u64(value);
    }

    parts.push(local.result, blob);
    directory.push(central.result);
    offset += local.result.length + size;
  }

  const directoryOffset = offset;
  const directorySize = directory.reduce((sum, header) => sum + header.length, 0);
  parts.push(...directory);
  if (directoryOffset >= MAX32 || directorySize >= MAX32) zip64 = true;

  if (zip64) {
    const record = new Writer(56 + 20);
    record.u32(ZIP64_END);
    record.u64(44); // the size of the rest of the record
    record.u16(VERSION_ZIP64);
    record.u16(VERSION_ZIP64);
    record.u32(0); // this disk
    record.u32(0); // the directory's disk
    record.u64(entries.length);
    record.u64(entries.length);
    record.u64(directorySize);
    record.u64(directoryOffset);
    record.u32(ZIP64_LOCATOR);
    record.u32(0); // the record's disk
    record.u64(directoryOffset + directorySize);
    record.u32(1); // disks
    parts.push(record.result);
  }
  const end = new Writer(END_SIZE);
  end.u32(END);
  end.u16(0);
  end.u16(0);
  end.u16(zip64 ? MAX16 : entries.length);
  end.u16(zip64 ? MAX16 : entries.length);
  end.u32(zip64 ? MAX32 : directorySize);
  end.u32(zip64 ? MAX32 : directoryOffset);
  end.u16(0); // comment
  parts.push(end.result);
  return parts;
}

/**
 * @param {ZipInput[]} entries
 * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<Blob>} a ZIP of them, stored
 */
export async function writeZip(entries, options) {
  return new Blob(/** @type {BlobPart[]} */ (await zipParts(entries, options)), {
    type: "application/zip",
  });
}

/**
 * Reads a ZIP's central directory and its entries' local headers.
 *
 * @param {BlobLike} zip
 * @returns {Promise<ZipEntry[]>} its entries, files and folders alike
 * @throws {ZipError} if it isn't a ZIP, or is damaged
 */
export async function readZip(zip) {
  if (zip.size < END_SIZE) throw new ZipError("not-zip", "It's too small to be a ZIP");
  const tailStart = Math.max(0, zip.size - END_SIZE - MAX_COMMENT);
  const tail = await read(zip, tailStart, zip.size);
  let endAt = -1;
  for (let at = tail.byteLength - END_SIZE; at >= 0; at--) {
    if (tail.getUint32(at, true) === END && at + END_SIZE + tail.getUint16(at + 20, true) <= tail.byteLength) {
      endAt = at;
      break;
    }
  }
  if (endAt < 0) throw new ZipError("not-zip", "It has no end of central directory record");

  let count = tail.getUint16(endAt + 10, true);
  let directorySize = tail.getUint32(endAt + 12, true);
  let directoryOffset = tail.getUint32(endAt + 16, true);
  /** Where the records after the central directory start. */
  let directoryEnd = tailStart + endAt;
  if (count === MAX16 || directorySize === MAX32 || directoryOffset === MAX32) {
    if (endAt < 20 || tail.getUint32(endAt - 20, true) !== ZIP64_LOCATOR) {
      throw new ZipError("damaged", "Its ZIP64 locator is missing");
    }
    const recordAt = safeNumber(tail.getBigUint64(endAt - 12, true));
    if (recordAt + 56 > directoryEnd - 20) throw new ZipError("damaged", "Its ZIP64 record is outside it");
    const record = await read(zip, recordAt, recordAt + 56);
    if (record.getUint32(0, true) !== ZIP64_END) throw new ZipError("damaged", "Its ZIP64 record is missing");
    count = safeNumber(record.getBigUint64(32, true));
    directorySize = safeNumber(record.getBigUint64(40, true));
    directoryOffset = safeNumber(record.getBigUint64(48, true));
    directoryEnd = recordAt;
  }
  if (count > MAX_ENTRIES) throw new ZipError("too-large", "It has too many entries");
  if (directorySize > MAX_DIRECTORY_BYTES) throw new ZipError("too-large", "Its central directory is too large");
  if (directoryOffset + directorySize > directoryEnd) {
    throw new ZipError("damaged", "Its central directory is outside it");
  }

  const directory = await read(zip, directoryOffset, directoryOffset + directorySize);
  const decoder = new TextDecoder();
  /** @type {(ZipEntry & { headerOffset: number })[]} */
  const entries = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new ZipError("damaged", "Its central directory is damaged");
    }
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const crc = directory.getUint32(at + 16, true);
    let compressedSize = directory.getUint32(at + 20, true);
    let size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    let headerOffset = directory.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directory.byteLength) throw new ZipError("damaged", "Its central directory is damaged");
    const name = decoder.decode(
      new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength),
    );

    // ZIP64's extra field holds the values too large for their own fields.
    if (size === MAX32 || compressedSize === MAX32 || headerOffset === MAX32) {
      const extra = findExtra(directory, at + 46 + nameLength, extraLength, ZIP64_EXTRA);
      if (!extra) throw new ZipError("damaged", `Entry ${name} has no ZIP64 field`);
      let field = extra.start;
      const next64 = () => {
        if (field + 8 > extra.end) throw new ZipError("damaged", `Entry ${name}'s ZIP64 field is short`);
        const value = safeNumber(directory.getBigUint64(field, true));
        field += 8;
        return value;
      };
      if (size === MAX32) size = next64();
      if (compressedSize === MAX32) compressedSize = next64();
      if (headerOffset === MAX32) headerOffset = next64();
    }
    entries.push({
      name,
      method,
      encrypted: (flags & ENCRYPTED) !== 0,
      crc32: crc,
      compressedSize,
      size,
      offset: 0,
      headerOffset,
    });
    at = next;
  }

  // Each entry's data starts after its local header, whose name and extra
  // field may differ from the central directory's.
  for (const entry of entries) {
    if (entry.headerOffset + 30 > directoryOffset) throw new ZipError("damaged", `Entry ${entry.name} is outside it`);
    const header = await read(zip, entry.headerOffset, entry.headerOffset + 30);
    if (header.getUint32(0, true) !== LOCAL_HEADER) {
      throw new ZipError("damaged", `Entry ${entry.name} has no local header`);
    }
    entry.offset = entry.headerOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (entry.offset + entry.compressedSize > directoryOffset) {
      throw new ZipError("damaged", `Entry ${entry.name} is outside it`);
    }
  }
  const ordered = [...entries].sort((a, b) => a.headerOffset - b.headerOffset);
  for (let index = 1; index < ordered.length; index++) {
    const before = ordered[index - 1];
    if (ordered[index].headerOffset < before.offset + before.compressedSize) {
      throw new ZipError("damaged", `Entries ${before.name} and ${ordered[index].name} overlap`);
    }
  }
  return entries.map(({ headerOffset: _, ...entry }) => entry);
}

/**
 * Reads an entry, checking its size and CRC-32.
 *
 * @param {BlobLike} zip
 * @param {ZipEntry} entry of `zip`
 * @param {{ maxSize?: number, signal?: AbortSignal }} [options] the most it
 *   may hold, uncompressed
 * @returns {Promise<BlobLike>} its contents: a slice of `zip` for a stored
 *   entry, which isn't read into memory
 * @throws {ZipError} if it can't be read, or isn't what the ZIP says
 */
export async function readEntry(zip, entry, { maxSize = Number.MAX_SAFE_INTEGER, signal } = {}) {
  if (entry.encrypted) throw new ZipError("encrypted", `${entry.name} is encrypted`);
  if (entry.size > maxSize) throw new ZipError("too-large", `${entry.name} is too large`);
  const data = zip.slice(entry.offset, entry.offset + entry.compressedSize);
  if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) throw new ZipError("damaged", `${entry.name}'s sizes differ`);
    if ((await crc32Of(data, { signal })) !== entry.crc32) {
      throw new ZipError("checksum", `${entry.name} isn't what the ZIP says`);
    }
    return data;
  }
  if (entry.method !== DEFLATED) throw new ZipError("unsupported", `${entry.name} is compressed in a way PDFLion can't read`);

  const reader = data.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  let crc = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      // Never more than the ZIP says, however small the compressed data.
      if (size > entry.size) throw new ZipError("damaged", `${entry.name} is larger than the ZIP says`);
      crc = crc32(value, crc);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof ZipError || /** @type {Error} */ (error)?.name === "AbortError") throw error;
    throw new ZipError("damaged", `${entry.name} can't be decompressed`);
  }
  if (size !== entry.size || crc !== entry.crc32) {
    throw new ZipError("checksum", `${entry.name} isn't what the ZIP says`);
  }
  return new Blob(/** @type {BlobPart[]} */ (chunks));
}

/**
 * @param {DataView} view
 * @param {number} start
 * @param {number} length
 * @param {number} id
 * @returns {{ start: number, end: number } | null} where the extra field of
 *   that id has its data
 */
function findExtra(view, start, length, id) {
  const end = start + length;
  for (let at = start; at + 4 <= end; ) {
    const size = view.getUint16(at + 2, true);
    if (at + 4 + size > end) return null;
    if (view.getUint16(at, true) === id) return { start: at + 4, end: at + 4 + size };
    at += 4 + size;
  }
  return null;
}

/**
 * @param {BlobLike} blob
 * @param {number} start
 * @param {number} end
 * @returns {Promise<DataView>} those bytes
 */
async function read(blob, start, end) {
  if (start < 0 || end > blob.size || start > end) throw new ZipError("damaged", "A record is outside it");
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/**
 * @param {bigint} value
 * @returns {number}
 */
function safeNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("damaged", "A size is too large");
  return Number(value);
}

/**
 * @param {Date} date
 * @returns {[number, number]} its time and date as MS-DOS has them, in local
 *   time, from 1980 on
 */
function dosTime(date) {
  if (date.getFullYear() < 1980) return [0, (1 << 5) | 1];
  return [
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  ];
}

/** Writes a header's fields, little-endian. */
class Writer {
  /** @param {number} size */
  constructor(size) {
    this.result = new Uint8Array(size);
    this.view = new DataView(this.result.buffer);
    this.at = 0;
  }
  /** @param {number} value */
  u16(value) {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
  }
  /** @param {number} value */
  u32(value) {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
  }
  /** @param {number} value */
  u64(value) {
    this.view.setBigUint64(this.at, BigInt(value), true);
    this.at += 8;
  }
  /** @param {Uint8Array} bytes */
  bytes(bytes) {
    this.result.set(bytes, this.at);
    this.at += bytes.length;
  }
}
