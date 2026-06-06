// IndexedDB connection helper. Single function: openDb().
// Creates / upgrades the schema declared in schema.js (raw IDB, no deps).

import { DB_NAME, DB_VERSION, STORES } from './schema.js';

export function openDb(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      for (const [storeName, def] of Object.entries(STORES)) {
        const store = db.objectStoreNames.contains(storeName)
          ? tx.objectStore(storeName)
          : db.createObjectStore(storeName, {
            keyPath: def.keyPath,
            autoIncrement: !!def.autoIncrement,
          });
        for (const idx of def.indexes) {
          const [idxName, keyPath] = idx;
          if (!store.indexNames.contains(idxName)) {
            store.createIndex(idxName, keyPath ?? idxName);
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Small shared promise wrappers over the IDB request/transaction lifecycle.
export function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
