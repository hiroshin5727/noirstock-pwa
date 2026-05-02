export const APP_NAME = 'NoirStock';
export const APP_SCHEMA_VERSION = '6.3.0';

export const STORE_NAMES = ['inventory', 'sales', 'expenses', 'settings', 'ocrRecords', 'backups'];

export function emptyDataset() {
  return {
    app: APP_NAME,
    schemaVersion: APP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    inventory: [],
    inventories: [],
    sales: [],
    expenses: [],
    settings: [],
    ocrRecords: [],
    backups: [],
    meta: {
      normalizedAt: new Date().toISOString(),
      sourceShape: 'empty',
      warnings: [],
      notes: [],
    },
  };
}

export function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function countDataset(dataset = {}) {
  const inventory = normalizeArray(dataset.inventory || dataset.inventories);
  return {
    inventory: inventory.length,
    sales: normalizeArray(dataset.sales).length,
    expenses: normalizeArray(dataset.expenses).length,
    ocrRecords: normalizeArray(dataset.ocrRecords).length,
    settings: normalizeArray(dataset.settings).length,
  };
}
