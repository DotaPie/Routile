/* IndexedDB cache: Overpass downloads and computed routes.

   Overpass is slow and flaky, and a route takes seconds to compute, so both
   are kept. Everything is regenerable; the cache is a convenience and degrades
   to a no-op wherever IndexedDB is unavailable (private windows, blocked
   storage) rather than ever failing a compute. */

const DB_NAME = 'routile';
const DB_VERSION = 1;
const STORES = ['overpass', 'results'];

const NOOP = { get: async () => null, put: async () => {}, clear: async () => {} };

export async function openCache() {
  if (typeof indexedDB === 'undefined') return NOOP;
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  } catch (err) {
    console.warn('cache unavailable:', err.message);
    return NOOP;
  }

  const request = (store, mode, op) => new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = op(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('cache error:', req.error); resolve(undefined); };
    } catch (err) {
      console.warn('cache error:', err.message);
      resolve(undefined);
    }
  });

  return {
    get: async (store, key) => (await request(store, 'readonly', (s) => s.get(key))) ?? null,
    put: async (store, key, value) => { await request(store, 'readwrite', (s) => s.put(value, key)); },
    clear: async (store) => { await request(store, 'readwrite', (s) => s.clear()); },
  };
}
