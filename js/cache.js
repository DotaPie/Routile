/* IndexedDB for Overpass downloads, computed routes and the page's own saved
   session. The first two are regenerable and the third is a convenience, so all
   of it degrades to a no-op wherever IndexedDB is unavailable rather than ever
   failing a compute.

   `session` is the odd one out: it is what the page was showing when it was
   last closed rather than an answer to a request, so it is keyed by hand rather
   than by a request key, and only Clear empties it. */

const DB_NAME = 'routile';
const DB_VERSION = 2;
const STORES = ['overpass', 'results', 'session'];

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
