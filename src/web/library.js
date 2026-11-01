/**
 * The web app's library: the documents PDFLion keeps, in IndexedDB, since
 * Safari can't write back to the files they came from. The shell keeps it,
 * and the service worker serves documents from it at `doc/<id>/<name>`.
 *
 * Database `pdflion`, with these object stores:
 * - `documents`: a record of each document (DocumentRecord), by its id
 * - `bytes`: its latest revision, as a Blob, by its id. A save writes it and
 *   raises the record's revision in one transaction, so a save cut short
 *   leaves the revision before it.
 * - `thumbnails`: its first page as a PNG Blob, by its id
 * - `settings`: what the user chose, by name, such as `toolSettings`
 * - `session`: the open tabs, for when iPadOS ends the app
 *
 * Its version goes up with every change of these, and upgrade() takes a
 * database of any earlier version along without losing anything.
 * Free of the shell, so that the service worker can import it.
 */

export const DATABASE_NAME = "pdflion";

/** The schema's version. */
const DATABASE_VERSION = 1;

/** The longest name a document may have, as most file systems allow. */
const MAX_NAME_LENGTH = 255;

/**
 * @typedef {object} DocumentRecord
 * @property {string} id a random UUID
 * @property {string} name its file name, such as `Report.pdf`
 * @property {number} size its latest revision's, in bytes
 * @property {number} createdAt when it came into the library, in ms
 * @property {number} openedAt when it was last opened, in ms
 * @property {number} modifiedAt when it was last saved, in ms
 * @property {number} revision 0 as it came in, and one more with every save
 * @property {number} exportedRevision the revision as it came from Files or
 *   was last shared, or -1 if it never was: the copy has changes the file
 *   doesn't while it's lower than `revision`
 * @property {"files" | "new" | "drop"} source where it came from: the file
 *   picker, New, or a drop
 * @property {string | null} sha256 of the file it came from or was last
 *   shared as, in hex, or null for one PDFLion made and never shared
 */

/** @type {(value: unknown) => boolean} */
const isUuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/**
 * @param {unknown} id
 * @returns {id is string} whether `id` has the form of a document's
 */
export function isDocumentId(id) {
  return isUuid(id);
}

/**
 * @param {unknown} name
 * @returns {string | null} `name` as a document's name: a single file name,
 *   without control characters, of at most MAX_NAME_LENGTH characters, or
 *   null if nothing is left of it
 */
export function cleanName(name) {
  if (typeof name !== "string") return null;
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? null : cleaned;
}

/**
 * @param {DocumentRecord} record
 * @returns {boolean} whether the copy has changes the file in Files doesn't,
 *   or PDFLion made it and it was never shared
 */
export function isNotInFiles(record) {
  return record.revision > record.exportedRevision;
}

/**
 * @param {DocumentRecord[]} records
 * @param {string} name
 * @returns {string} `name`, or with " 2", " 3" and so on before its
 *   extension, whichever no record has
 */
export function freeName(records, name) {
  const taken = new Set(records.map((record) => record.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The open database, which the shell and the service worker each keep one
 * connection to.
 */
export class Library {
  /** @type {IDBDatabase} */
  #database;

  /** @param {IDBDatabase} database */
  constructor(database) {
    this.#database = database;
  }

  /**
   * Opens the library, making or upgrading the database first.
   *
   * @returns {Promise<Library>}
   */
  static async open() {
    const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    open.onupgradeneeded = (event) => upgrade(open.result, event.oldVersion);
    const database = await settled(open);
    // A newer version, in another page or a new service worker, waits for
    // this connection to close.
    database.onversionchange = () => database.close();
    return new Library(database);
  }

  close() {
    this.#database.close();
  }

  /** @returns {Promise<DocumentRecord[]>} every document, the most recently opened first */
  async documents() {
    /** @type {DocumentRecord[]} */
    const records = await settled(this.#store("documents").getAll());
    return records.sort((a, b) => b.openedAt - a.openedAt);
  }

  /**
   * @param {string} id
   * @returns {Promise<DocumentRecord | undefined>}
   */
  document(id) {
    return settled(this.#store("documents").get(id));
  }

  /**
   * @param {string} id
   * @returns {Promise<Blob | undefined>} its latest revision
   */
  bytes(id) {
    return settled(this.#store("bytes").get(id));
  }

  /**
   * A document and its bytes as they are together, for the service worker.
   *
   * @param {string} id
   * @returns {Promise<{ record: DocumentRecord, blob: Blob } | null>}
   */
  async read(id) {
    const transaction = this.#database.transaction(["documents", "bytes"]);
    const [record, blob] = await Promise.all([
      settled(transaction.objectStore("documents").get(id)),
      settled(transaction.objectStore("bytes").get(id)),
    ]);
    return record && blob ? { record, blob } : null;
  }

  /**
   * @param {string} sha256
   * @returns {Promise<DocumentRecord | undefined>} a document that came from,
   *   or was last shared as, a file with these contents
   */
  findBySha256(sha256) {
    return settled(this.#store("documents").index("sha256").get(sha256));
  }

  /**
   * Adds a document, with a new id.
   *
   * @param {{ name: string, blob: Blob, source: DocumentRecord["source"], sha256: string | null }} document
   * @returns {Promise<DocumentRecord>}
   */
  async add({ name, blob, source, sha256 }) {
    const now = Date.now();
    /** @type {DocumentRecord} */
    const record = {
      id: crypto.randomUUID(),
      name,
      size: blob.size,
      createdAt: now,
      openedAt: now,
      modifiedAt: now,
      revision: 0,
      exportedRevision: source === "new" ? -1 : 0,
      source,
      sha256,
    };
    await this.#write(["documents", "bytes"], (transaction) => {
      transaction.objectStore("documents").add(record);
      transaction.objectStore("bytes").add(blob, record.id);
    });
    return record;
  }

  /**
   * Stores a new revision of a document.
   *
   * @param {string} id
   * @param {Blob} blob
   * @returns {Promise<DocumentRecord>} its record now
   */
  async save(id, blob) {
    /** @type {DocumentRecord | undefined} */
    let record;
    await this.#write(["documents", "bytes"], async (transaction) => {
      const documents = transaction.objectStore("documents");
      const current = await settled(documents.get(id));
      if (!current) throw new Error(`There's no document ${id}`);
      record = {
        ...current,
        size: blob.size,
        modifiedAt: Date.now(),
        revision: current.revision + 1,
      };
      documents.put(record);
      transaction.objectStore("bytes").put(blob, id);
    });
    return /** @type {DocumentRecord} */ (record);
  }

  /**
   * Changes a document's record.
   *
   * @param {string} id
   * @param {Partial<Pick<DocumentRecord, "name" | "openedAt" | "exportedRevision" | "sha256">>} changes
   * @returns {Promise<DocumentRecord | undefined>} its record now, or
   *   undefined if there's no such document
   */
  async update(id, changes) {
    /** @type {DocumentRecord | undefined} */
    let record;
    await this.#write(["documents"], async (transaction) => {
      const documents = transaction.objectStore("documents");
      const current = await settled(documents.get(id));
      if (!current) return;
      record = { ...current, ...changes };
      documents.put(record);
    });
    return record;
  }

  /**
   * Deletes a document, its bytes and its thumbnail.
   *
   * @param {string} id
   */
  async remove(id) {
    await this.#write(["documents", "bytes", "thumbnails"], (transaction) => {
      for (const store of ["documents", "bytes", "thumbnails"]) {
        transaction.objectStore(store).delete(id);
      }
    });
  }

  /** @returns {Promise<Map<string, Blob>>} every document's thumbnail, by its id */
  async thumbnails() {
    const store = this.#store("thumbnails");
    const [keys, blobs] = await Promise.all([
      settled(store.getAllKeys()),
      settled(store.getAll()),
    ]);
    return new Map(keys.map((key, index) => [String(key), blobs[index]]));
  }

  /**
   * @param {string} id a document's
   * @param {Blob} blob a PNG
   */
  async setThumbnail(id, blob) {
    await this.#write(["documents", "thumbnails"], async (transaction) => {
      // Not for a document deleted meanwhile.
      if (await settled(transaction.objectStore("documents").getKey(id))) {
        transaction.objectStore("thumbnails").put(blob, id);
      }
    });
  }

  /**
   * @param {string} name
   * @returns {Promise<unknown>} the setting, as stored, which the caller checks
   */
  setting(name) {
    return settled(this.#store("settings").get(name));
  }

  /**
   * @param {string} name
   * @param {unknown} value
   */
  async setSetting(name, value) {
    await this.#write(["settings"], (transaction) => {
      transaction.objectStore("settings").put(value, name);
    });
  }

  /**
   * @param {string} name
   * @returns {IDBObjectStore} for reading
   */
  #store(name) {
    return this.#database.transaction(name).objectStore(name);
  }

  /**
   * Runs `change` in a read-write transaction, and settles once that's
   * committed. If `change` throws, nothing it did is kept.
   *
   * @param {string[]} stores
   * @param {(transaction: IDBTransaction) => void | Promise<void>} change
   */
  #write(stores, change) {
    const transaction = this.#database.transaction(stores, "readwrite");
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("The transaction was aborted"));
    });
    return Promise.resolve()
      .then(() => change(transaction))
      .then(
        () => done,
        (error) => {
          try {
            transaction.abort();
          } catch {
            // It had finished already.
          }
          done.catch(() => {});
          throw error;
        },
      );
  }
}

/**
 * Makes or upgrades the database, from the version it had, one step at a
 * time.
 *
 * @param {IDBDatabase} database
 * @param {number} from its version before, 0 for a new one
 */
function upgrade(database, from) {
  if (from < 1) {
    const documents = database.createObjectStore("documents", { keyPath: "id" });
    documents.createIndex("sha256", "sha256");
    database.createObjectStore("bytes");
    database.createObjectStore("thumbnails");
    database.createObjectStore("settings");
    database.createObjectStore("session");
  }
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function settled(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
