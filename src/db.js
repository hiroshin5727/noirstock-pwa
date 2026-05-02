import { APP_NAME, APP_SCHEMA_VERSION, STORE_NAMES } from './schema.js';

const DB_NAME = 'noirstock-db';
const DB_VERSION = 3;
const STORES = STORE_NAMES;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      STORES.forEach((store) => {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      });
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export async function getAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getOne(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function put(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

export async function remove(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function bulkReplace(dataMap) {
  const db = await openDB();
  const writableStores = STORES.filter((store) => store !== 'backups' || dataMap.__replaceBackups === true);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(writableStores, 'readwrite');
    writableStores.forEach((store) => {
      const bucket = tx.objectStore(store);
      bucket.clear();
      (dataMap[store] || []).forEach((item) => bucket.put(item));
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function exportAll() {
  const inventory = await getAll('inventory');
  const sales = await getAll('sales');
  const expenses = await getAll('expenses');
  const settings = await getAll('settings');
  const ocrRecords = await getAll('ocrRecords');
  return {
    app: APP_NAME,
    schemaVersion: APP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    inventory,
    inventories: inventory,
    sales,
    expenses,
    settings,
    ocrRecords,
    meta: {
      source: 'NoirStock PWA',
      exportType: 'backup',
      notes: ['分析値は保存せず、Import後に都度再計算します。'],
    },
  };
}

export async function createAutoBackup(reason = 'before-import') {
  const payload = await exportAll();
  const backup = {
    id: `backup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    reason,
    createdAt: new Date().toISOString(),
    schemaVersion: APP_SCHEMA_VERSION,
    payload,
  };
  await put('backups', backup);
  return backup;
}
