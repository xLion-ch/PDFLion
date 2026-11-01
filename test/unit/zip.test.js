import assert from "node:assert/strict";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { ZipError, crc32, readEntry, readZip, writeZip, zipParts } from "../../src/shared/zip.js";

const encoder = new TextEncoder();

/**
 * A stand-in for a Blob of parts, some of which are only sizes: zeros that
 * take no memory, for ZIPs past 4 GiB.
 */
class SparseBlob {
  /** @param {(Uint8Array | { size: number })[]} parts */
  constructor(parts) {
    this.parts = parts;
    this.size = parts.reduce((sum, part) => sum + (part instanceof Uint8Array ? part.length : part.size), 0);
  }
  /**
   * @param {number} [start]
   * @param {number} [end]
   */
  slice(start = 0, end = this.size) {
    /** @type {(Uint8Array | { size: number })[]} */
    const parts = [];
    let at = 0;
    for (const part of this.parts) {
      const size = part instanceof Uint8Array ? part.length : part.size;
      const from = Math.max(start, at);
      const to = Math.min(end, at + size);
      if (from < to) {
        parts.push(part instanceof Uint8Array ? part.subarray(from - at, to - at) : { size: to - from });
      }
      at += size;
    }
    return new SparseBlob(parts);
  }
  async arrayBuffer() {
    const bytes = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      if (part instanceof Uint8Array) bytes.set(part, at);
      at += part instanceof Uint8Array ? part.length : part.size;
    }
    return bytes.buffer;
  }
  stream() {
    throw new Error("not needed");
  }
}

/**
 * @param {{ name: string, data: Uint8Array, deflate?: boolean, flags?: number }[]} files
 * @returns {Blob} a ZIP as other apps make them, with data descriptors
 *   neither, but deflated entries
 */
function otherZip(files) {
  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {Uint8Array[]} */
  const directory = [];
  let offset = 0;
  for (const { name, data, deflate = false, flags = 0 } of files) {
    const nameBytes = encoder.encode(name);
    const body = deflate ? new Uint8Array(zlib.deflateRawSync(data)) : data;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(14, crc32(data), true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, flags, true);
    central.setUint16(10, deflate ? 8 : 0, true);
    central.setUint32(16, crc32(data), true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    directory.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, new Uint8Array(end.buffer)]);
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} reason
 */
async function rejectsWith(promise, reason) {
  await assert.rejects(promise, (error) => error instanceof ZipError && error.reason === reason);
}

describe("zip.js", () => {
  it("computes CRC-32 as ZIP does, also in parts", () => {
    assert.equal(crc32(encoder.encode("123456789")), 0xcbf43926);
    assert.equal(crc32(encoder.encode("6789"), crc32(encoder.encode("12345"))), 0xcbf43926);
    assert.equal(crc32(new Uint8Array()), 0);
  });

  it("writes stored entries that it reads back, with their names in UTF-8", async () => {
    const files = [
      { name: "PDFLion Settings.json", blob: new Blob(['{"a":1}']) },
      { name: "Documents/Bericht – März.pdf", blob: new Blob([new Uint8Array(3_000_000).fill(7)]) },
      { name: "Thumbnails/x.png", blob: new Blob([]) },
    ];
    /** @type {number[]} */
    const progress = [];
    const zip = await writeZip(files, { onProgress: (done) => progress.push(done) });
    assert.equal(zip.type, "application/zip");
    assert.equal(progress.at(-1), 3_000_007);

    const entries = await readZip(zip);
    assert.deepEqual(
      entries.map(({ name, size, method }) => ({ name, size, method })),
      files.map(({ name, blob }) => ({ name, size: blob.size, method: 0 })),
    );
    for (const [index, entry] of entries.entries()) {
      const read = await readEntry(zip, entry);
      assert.deepEqual(new Uint8Array(await read.arrayBuffer()), new Uint8Array(await files[index].blob.arrayBuffer()));
    }
    // It starts as every ZIP does.
    assert.equal(new DataView(await zip.slice(0, 4).arrayBuffer()).getUint32(0, true), 0x04034b50);
  });

  it("stops when asked to", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      writeZip([{ name: "a", blob: new Blob(["x"]) }], { signal: controller.signal }),
      /abort/i,
    );
  });

  it("reads deflated entries, as another app zips them", async () => {
    const data = encoder.encode("%PDF-1.7\n".repeat(10_000));
    const zip = otherZip([
      { name: "Backup/Library.json", data: encoder.encode("{}"), deflate: true },
      { name: "Backup/Documents/A.pdf", data, deflate: true },
    ]);
    const entries = await readZip(zip);
    assert.deepEqual(
      entries.map(({ name, method, size }) => [name, method, size]),
      [
        ["Backup/Library.json", 8, 2],
        ["Backup/Documents/A.pdf", 8, data.length],
      ],
    );
    assert.deepEqual(new Uint8Array(await (await readEntry(zip, entries[1])).arrayBuffer()), data);
    await rejectsWith(readEntry(zip, entries[1], { maxSize: 100 }), "too-large");
  });

  it("refuses an entry that isn't what the ZIP says, or inflates past its size", async () => {
    const data = encoder.encode("x".repeat(1000));
    const zip = otherZip([
      { name: "a", data },
      { name: "b", data, deflate: true },
    ]);
    const entries = await readZip(zip);
    await rejectsWith(readEntry(zip, { ...entries[0], crc32: entries[0].crc32 ^ 1 }), "checksum");
    await rejectsWith(readEntry(zip, { ...entries[1], crc32: entries[1].crc32 ^ 1 }), "checksum");
    await rejectsWith(readEntry(zip, { ...entries[1], size: 10 }), "damaged");
    await rejectsWith(readEntry(zip, { ...entries[1], method: 12 }), "unsupported");
  });

  it("refuses encrypted entries, but lists them", async () => {
    const zip = otherZip([{ name: "secret.pdf", data: encoder.encode("x"), flags: 1 }]);
    const [entry] = await readZip(zip);
    assert.equal(entry.encrypted, true);
    await rejectsWith(readEntry(zip, entry), "encrypted");
  });

  it("refuses what isn't a ZIP, a truncated one, and entries that overlap or lie outside it", async () => {
    await rejectsWith(readZip(new Blob(["%PDF-1.7"])), "not-zip");
    await rejectsWith(readZip(new Blob([new Uint8Array(100)])), "not-zip");
    const zip = await writeZip([
      { name: "a", blob: new Blob(["aaaa"]) },
      { name: "b", blob: new Blob(["bbbb"]) },
    ]);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    // Truncated at the front: every offset points elsewhere.
    await assert.rejects(readZip(new Blob([bytes.subarray(10)])), ZipError);
    // Truncated at the end: no end record.
    await rejectsWith(readZip(new Blob([bytes.subarray(0, bytes.length - 5)])), "not-zip");

    const directoryAt = new DataView(bytes.buffer).getUint32(bytes.length - 6, true);
    const secondAt = directoryAt + 46 + 1;
    // The second entry starts inside the first.
    const overlapping = bytes.slice();
    new DataView(overlapping.buffer).setUint32(secondAt + 42, 10, true);
    await rejectsWith(readZip(new Blob([overlapping])), "damaged");
    // The second entry's data passes into the central directory.
    const outside = bytes.slice();
    new DataView(outside.buffer).setUint32(secondAt + 20, 1000, true);
    await rejectsWith(readZip(new Blob([outside])), "damaged");
    // The central directory passes the end.
    const longDirectory = bytes.slice();
    new DataView(longDirectory.buffer).setUint32(longDirectory.length - 10, 10_000, true);
    await rejectsWith(readZip(new Blob([longDirectory])), "damaged");
  });

  it("writes and reads ZIP64 records past 4 GiB", async () => {
    const huge = 5 * 2 ** 30;
    const big = new SparseBlob([{ size: huge }]);
    const parts = await zipParts([
      { name: "Documents/Big.pdf", blob: /** @type {any} */ (big), crc32: 0x12345678 },
      { name: "Documents/After.pdf", blob: new Blob(["%PDF-"]) },
    ]);
    const sparse = new SparseBlob(
      await Promise.all(
        parts.map(async (part) =>
          part instanceof Uint8Array ? part : part instanceof SparseBlob ? { size: part.size } : new Uint8Array(await part.arrayBuffer()),
        ),
      ),
    );
    const entries = await readZip(/** @type {any} */ (sparse));
    assert.deepEqual(
      entries.map(({ name, size, crc32: crc }) => [name, size, crc]),
      [
        ["Documents/Big.pdf", huge, 0x12345678],
        ["Documents/After.pdf", 5, crc32(encoder.encode("%PDF-"))],
      ],
    );
    // The second entry lies past 4 GiB, which only ZIP64 can say.
    assert.ok(entries[1].offset > 2 ** 32);
    const after = await readEntry(/** @type {any} */ (sparse), entries[1]);
    assert.equal(new TextDecoder().decode(await after.arrayBuffer()), "%PDF-");
  });
});
