// Base de datos local (IndexedDB): catálogo de cartuchos + colección del usuario
const DB_NAME = 'evercade-library';
const DB_VERSION = 2;

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = (name) => db.objectStoreNames.contains(name);
      if (!has('cartridges')) db.createObjectStore('cartridges', { keyPath: 'id' });
      if (!has('owned')) db.createObjectStore('owned', { keyPath: 'id' });
      if (!has('meta')) db.createObjectStore('meta');
      // Juegos pasados: id = "<cartucho>::<título normalizado>"
      if (!has('completed')) db.createObjectStore('completed', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function getMeta(key) {
  return done((await store('meta')).get(key));
}

export async function getCartridges() {
  return done((await store('cartridges')).getAll());
}

// Sustituye el catálogo completo; la colección (owned) no se toca
export async function replaceCatalog(catalog) {
  const tx = (await open()).transaction(['cartridges', 'meta'], 'readwrite');
  const carts = tx.objectStore('cartridges');
  carts.clear();
  catalog.cartridges.forEach((c) => carts.put(c));
  tx.objectStore('meta').put(catalog.updatedAt, 'catalogUpdatedAt');
  return txDone(tx);
}

export async function getOwned() {
  return done((await store('owned')).getAll());
}

export async function setOwned(id, owned) {
  const s = await store('owned', 'readwrite');
  return done(owned ? s.put({ id, addedAt: new Date().toISOString() }) : s.delete(id));
}

export async function replaceOwned(entries) {
  const tx = (await open()).transaction('owned', 'readwrite');
  const s = tx.objectStore('owned');
  s.clear();
  entries.forEach((e) => s.put(e));
  return txDone(tx);
}

export async function getCompleted() {
  return done((await store('completed')).getAll());
}

export async function setCompleted(id, completed) {
  const s = await store('completed', 'readwrite');
  return done(completed ? s.put({ id, completedAt: new Date().toISOString() }) : s.delete(id));
}

export async function replaceCompleted(entries) {
  const tx = (await open()).transaction('completed', 'readwrite');
  const s = tx.objectStore('completed');
  s.clear();
  entries.forEach((e) => s.put(e));
  return txDone(tx);
}
