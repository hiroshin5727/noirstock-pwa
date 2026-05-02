import { APP_NAME, APP_SCHEMA_VERSION, emptyDataset, normalizeArray } from './schema.js';
import { uid, safeNum, todayDate } from './utils.js';
import { createEmptyOcrRecord } from './ocrModel.js';

function cleanMoney(value) {
  if (typeof value === 'string') return safeNum(value.replace(/[¥￥,\s]/g, ''));
  return safeNum(value);
}

function asDateLike(value, fallback = '') {
  if (!value) return fallback;
  if (typeof value === 'string') {
    const s = value.trim();
    const jp = s.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/);
    if (jp) {
      const [, y, m, d, h, min] = jp;
      const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return h ? `${date}T${String(h).padStart(2, '0')}:${min}` : date;
    }
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return s.replace(/\//g, '-');
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      const local = new Date(parsed);
      local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
      return local.toISOString().slice(0, s.includes(':') ? 16 : 10);
    }
  }
  return fallback;
}

function ensureId(value, prefix, seen, notes) {
  let id = value || uid(prefix);
  if (seen.has(id)) {
    const original = id;
    id = uid(prefix);
    notes.push(`重複IDを変更: ${original} -> ${id}`);
  }
  seen.add(id);
  return id;
}

export function detectJsonShape(data = {}) {
  if (!data || typeof data !== 'object') return 'unknown';
  if (data.app === APP_NAME && String(data.schemaVersion || '').startsWith('6.2')) return 'v6.2';
  if (data.app === APP_NAME && data.schemaVersion) return `versioned:${data.schemaVersion}`;
  if (Array.isArray(data.inventory) || Array.isArray(data.sales) || Array.isArray(data.expenses)) return 'legacy-store-map';
  if (Array.isArray(data.inventories)) return 'versioned-inventories';
  if (Array.isArray(data.items)) return 'items-array';
  if (data.data && typeof data.data === 'object') return 'wrapped-data';
  return 'unknown';
}

function normalizeInventoryRow(row = {}, seen, notes) {
  const id = ensureId(row.id || row.inventoryId || row.sku, 'inv', seen, notes);
  const status = row.status || row.state || (row.sold ? '販売済' : '在庫中');
  return {
    ...row,
    id,
    name: row.name || row.title || row.productName || row.商品名 || '無題在庫',
    brand: row.brand || row.ブランド || '',
    category: row.category || row.カテゴリ || row.type || '',
    size: row.size || row.サイズ || '',
    color: row.color || row.色 || '',
    condition: row.condition || row.状態 || '',
    status,
    purchaseDate: asDateLike(row.purchaseDate || row.仕入日 || row.date || row.createdDate, ''),
    purchasePrice: cleanMoney(row.purchasePrice ?? row.cost ?? row.priceCost ?? row.仕入れ値 ?? row.原価),
    quantity: Math.max(1, cleanMoney(row.quantity ?? row.qty ?? row.数量 ?? 1)),
    plannedPrice: cleanMoney(row.plannedPrice ?? row.expectedPrice ?? row.予定売価 ?? row.想定売価),
    lotName: row.lotName || row.lot || row.SKU || row.sku || '',
    location: row.location || row.保管場所 || '',
    supplier: row.supplier || row.仕入先 || '',
    photoDataUrl: row.photoDataUrl || row.imageDataUrl || row.photo || '',
    createdAt: row.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSaleRow(row = {}, seen, notes) {
  const id = ensureId(row.id || row.saleId, 'sale', seen, notes);
  return {
    ...row,
    id,
    inventoryId: row.inventoryId || row.itemId || row.productId || '',
    saleDate: asDateLike(row.saleDate || row.date || row.販売日 || row.購入日時, ''),
    saleQty: Math.max(1, cleanMoney(row.saleQty ?? row.quantity ?? row.qty ?? row.数量 ?? 1)),
    salePrice: cleanMoney(row.salePrice ?? row.price ?? row.販売単価 ?? row.商品代金),
    platformFee: cleanMoney(row.platformFee ?? row.fee ?? row.販売手数料),
    shippingFee: cleanMoney(row.shippingFee ?? row.shipping ?? row.送料 ?? row.配送料),
    itemExpense: cleanMoney(row.itemExpense ?? row.additionalExpense ?? row.商品別追加経費),
    netAmount: row.netAmount === '' ? '' : cleanMoney(row.netAmount ?? row.販売利益 ?? row.受取額),
    platform: row.platform || row.market || row.販売先 || 'その他',
    paymentMethod: row.paymentMethod || row.入金方法 || '売上金',
    externalItemId: row.externalItemId || row.itemExternalId || row.商品ID || '',
    proofImageDataUrl: row.proofImageDataUrl || row.proofImage || '',
    ocrRecordId: row.ocrRecordId || '',
    ocrStatus: row.ocrStatus || (row.proofImageDataUrl && !row.externalItemId ? '未確定' : 'なし'),
    createdAt: row.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeExpenseRow(row = {}, seen, notes) {
  const id = ensureId(row.id || row.expenseId, 'exp', seen, notes);
  return {
    ...row,
    id,
    date: asDateLike(row.date || row.日付, todayDate()).slice(0, 10),
    title: row.title || row.name || row.内容 || row.category || '経費',
    category: row.category || row.区分 || 'その他',
    amount: cleanMoney(row.amount ?? row.金額 ?? row.price),
    method: row.method || row.支払方法 || 'その他',
    memo: row.memo || row.note || row.メモ || '',
    createdAt: row.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSettingsRow(row = {}, seen, notes) {
  const id = ensureId(row.id || row.key || 'settings', 'set', seen, notes);
  return { ...row, id, updatedAt: new Date().toISOString() };
}

export function normalizeToV62(input = {}, options = {}) {
  const raw = input?.data && typeof input.data === 'object' ? input.data : input;
  const sourceShape = detectJsonShape(input);
  const out = emptyDataset();
  const notes = [];
  const invSeen = new Set();
  const saleSeen = new Set();
  const expenseSeen = new Set();
  const settingsSeen = new Set();
  const ocrSeen = new Set();

  const inventoryRows = normalizeArray(raw.inventory || raw.inventories || raw.items);
  const saleRows = normalizeArray(raw.sales || raw.saleRecords || raw.soldItems);
  const expenseRows = normalizeArray(raw.expenses || raw.costs);
  const settingRows = normalizeArray(raw.settings);
  const ocrRows = normalizeArray(raw.ocrRecords || raw.ocr || raw.ocrResults);

  out.inventory = inventoryRows.map((row) => normalizeInventoryRow(row, invSeen, notes));
  out.inventories = out.inventory;
  out.sales = saleRows.map((row) => normalizeSaleRow(row, saleSeen, notes));
  out.expenses = expenseRows.map((row) => normalizeExpenseRow(row, expenseSeen, notes));
  out.settings = settingRows.map((row) => normalizeSettingsRow(row, settingsSeen, notes));
  out.ocrRecords = ocrRows.map((row) => createEmptyOcrRecord({ ...row, id: ensureId(row.id, 'ocr', ocrSeen, notes) }));
  out.backups = normalizeArray(raw.backups);
  out.meta = {
    ...(raw.meta || {}),
    sourceShape,
    normalizedAt: new Date().toISOString(),
    originalSchemaVersion: raw.schemaVersion || '',
    notes,
    importMode: options.mode || 'replace',
  };
  return out;
}

export function datasetForStores(dataset = {}) {
  return {
    inventory: dataset.inventory || dataset.inventories || [],
    sales: dataset.sales || [],
    expenses: dataset.expenses || [],
    settings: dataset.settings || [],
    ocrRecords: dataset.ocrRecords || [],
    backups: dataset.backups || [],
  };
}

export function mergeDatasets(current = {}, incoming = {}) {
  const merged = {
    inventory: [...(current.inventory || [])],
    sales: [...(current.sales || [])],
    expenses: [...(current.expenses || [])],
    settings: [...(current.settings || [])],
    ocrRecords: [...(current.ocrRecords || [])],
    backups: [...(current.backups || [])],
  };
  ['inventory', 'sales', 'expenses', 'settings', 'ocrRecords'].forEach((key) => {
    const map = new Map(merged[key].map((row) => [row.id, row]));
    (incoming[key] || incoming[`${key}s`] || []).forEach((row) => {
      const id = row.id || uid(key);
      map.set(id, { ...row, id });
    });
    merged[key] = [...map.values()];
  });
  return merged;
}
