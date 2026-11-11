// Interfaccia di storage: get/put/putMany/delete/clear su object store "meta" e "data".
// IdbStorage = IndexedDB reale (browser). MemoryStorage = test. In entrambi i casi i valori
// finanziari arrivano già CIFRATI dal livello vault: qui non esiste alcun dato in chiaro.
export class MemoryStorage {
  constructor() { this.stores = { meta: new Map(), data: new Map() }; }
  async get(s, k) { const v = this.stores[s].get(k); return v === undefined ? undefined : structuredClone(v); }
  async put(s, k, v) { this.stores[s].set(k, structuredClone(v)); }
  async putMany(entries) { for (const [s, k, v] of entries) this.stores[s].set(k, structuredClone(v)); }
  async delete(s, k) { this.stores[s].delete(k); }
  async clearAll() { for (const m of Object.values(this.stores)) m.clear(); }
  dump() { return JSON.stringify({ meta: [...this.stores.meta], data: [...this.stores.data] }); }
}

export class IdbStorage {
  constructor(name = 'fp-vault') { this.name = name; this.db = null; }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open(this.name, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
      };
      rq.onsuccess = () => { this.db = rq.result; resolve(this.db); };
      rq.onerror = () => reject(rq.error ?? new Error('IndexedDB non disponibile'));
      rq.onblocked = () => reject(new Error('IndexedDB bloccato da un\'altra scheda'));
    });
  }
  async #tx(stores, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transazione annullata'));
      result = fn(tx);
    });
  }
  async get(s, k) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const rq = db.transaction(s, 'readonly').objectStore(s).get(k);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  put(s, k, v) { return this.#tx([s], 'readwrite', (tx) => { tx.objectStore(s).put(v, k); }); }
  // Scrittura atomica di più chiavi: o tutte o nessuna.
  putMany(entries) {
    const stores = [...new Set(entries.map((e) => e[0]))];
    return this.#tx(stores, 'readwrite', (tx) => { for (const [s, k, v] of entries) tx.objectStore(s).put(v, k); });
  }
  delete(s, k) { return this.#tx([s], 'readwrite', (tx) => { tx.objectStore(s).delete(k); }); }
  clearAll() { return this.#tx(['meta', 'data'], 'readwrite', (tx) => { tx.objectStore('meta').clear(); tx.objectStore('data').clear(); }); }
}
