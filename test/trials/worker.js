/**
 * What a dedicated worker can do with the origin private file system, the
 * fallback for keeping documents if IndexedDB is slow:
 * createSyncAccessHandle() exists only in workers. features.js asks it once.
 */
self.addEventListener("message", async () => {
  /** @type {Record<string, unknown>} */
  const result = {
    getDirectory: typeof navigator.storage?.getDirectory === "function",
    createSyncAccessHandle:
      typeof FileSystemFileHandle === "function" &&
      typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function",
  };
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("trial-probe", { create: true });
    const access = await handle.createSyncAccessHandle();
    access.write(new Uint8Array([1, 2, 3]), { at: 0 });
    access.flush();
    result.syncWrite = access.getSize() === 3;
    access.close();
    await root.removeEntry("trial-probe");
  } catch (error) {
    result.syncWrite = `${error.name}: ${error.message}`;
  }
  postMessage(result);
});
