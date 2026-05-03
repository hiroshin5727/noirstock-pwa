import { uid, nowISO } from './utils.js';

export const APP_SCHEMA_VERSION = '6.5.0';

export function defaultTaxMappings() {
  return [
    { id: uid('map'), expenseCategory: '販売手数料', taxCategory: '支払手数料', memo: '販売ごとの手数料' },
    { id: uid('map'), expenseCategory: '送料', taxCategory: '荷造運賃', memo: '発送送料' },
    { id: uid('map'), expenseCategory: '梱包資材', taxCategory: '荷造運賃 / 消耗品費', memo: '要確認' },
    { id: uid('map'), expenseCategory: '材料購入', taxCategory: '材料仕入 / 製造原価関連', memo: 'ハンドメイド材料' },
    { id: uid('map'), expenseCategory: '外注加工', taxCategory: '外注費 / 製造原価関連', memo: '制作直接費' },
    { id: uid('map'), expenseCategory: '備品', taxCategory: '消耗品費 / 工具器具備品候補', memo: '金額により要確認' }
  ];
}

export function defaultTaxSettings() {
  return {
    year: new Date().getFullYear(),
    returnType: '未設定',
    incomeTypeMemo: '',
    inventoryMethodMemo: '期首在庫 + 当年仕入/製造原価 - 期末在庫',
    inventoryCheckedYears: []
  };
}

export function createEmptyDataset() {
  return {
    app: 'NoirStock',
    schemaVersion: APP_SCHEMA_VERSION,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    inventories: [],
    sales: [],
    expenses: [],
    ocrRecords: [],
    materials: [],
    materialPurchases: [],
    recipes: [],
    productionBatches: [],
    inventoryMovements: [],
    taxSettings: defaultTaxSettings(),
    taxMappings: defaultTaxMappings(),
    salesChannels: [],
    listingRecords: [],
    events: [],
    meta: {}
  };
}

export function createInventory(i = {}) {
  return {
    id: i.id || uid('inv'),
    sku: i.sku || '',
    name: i.name || '',
    brand: i.brand || '',
    size: i.size || '',
    productType: i.productType || 'resale',
    productCategory: i.productCategory || '',
    handmadeLine: i.handmadeLine || '',
    status: i.status || 'stock',
    quantity: Number(i.quantity ?? 1),
    costPrice: Number(i.costPrice ?? i.purchasePrice ?? 0),
    expectedPrice: Number(i.expectedPrice ?? 0),
    purchasedAt: i.purchasedAt || i.purchaseDate || '',
    batchId: i.batchId || null,
    currentListingIds: Array.isArray(i.currentListingIds) ? i.currentListingIds : [],
    imageData: i.imageData || '',
    notes: i.notes || i.memo || '',
    createdAt: i.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}

export function createSale(s = {}) {
  return {
    id: s.id || uid('sale'),
    inventoryId: s.inventoryId || null,
    soldAt: s.soldAt || s.saleDate || '',
    platform: s.platform || s.marketplace || '未設定',
    channelId: s.channelId || '',
    listingRecordId: s.listingRecordId || '',
    eventId: s.eventId || '',
    grossPrice: Number(s.grossPrice ?? s.salePrice ?? s.price ?? 0),
    fee: Number(s.fee ?? 0),
    shipping: Number(s.shipping ?? s.postage ?? 0),
    extraCost: Number(s.extraCost ?? 0),
    costPrice: Number(s.costPrice ?? 0),
    memo: s.memo || '',
    evidenceImage: s.evidenceImage || '',
    linkedOcrRecordId: s.linkedOcrRecordId || null,
    createdAt: s.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}

export function createExpense(e = {}) {
  return {
    id: e.id || uid('exp'),
    date: e.date || e.expenseDate || '',
    category: e.category || '未分類',
    taxCategory: e.taxCategory || '',
    amount: Number(e.amount ?? 0),
    vendor: e.vendor || '',
    memo: e.memo || e.notes || '',
    evidenceImage: e.evidenceImage || '',
    createdAt: e.createdAt || nowISO()
  };
}

export function createMaterial(m = {}) {
  return {
    id: m.id || uid('mat'),
    name: m.name || '',
    category: m.category || '材料',
    unit: m.unit || '個',
    memo: m.memo || '',
    reorderPoint: Number(m.reorderPoint ?? 0),
    evidenceImage: m.evidenceImage || '',
    createdAt: m.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}

export function createMaterialPurchase(p = {}) {
  return {
    id: p.id || uid('mp'),
    materialId: p.materialId || '',
    date: p.date || '',
    qty: Number(p.qty ?? 0),
    amount: Number(p.amount ?? 0),
    vendor: p.vendor || '',
    memo: p.memo || '',
    evidenceImage: p.evidenceImage || '',
    createdAt: p.createdAt || nowISO()
  };
}

export function createRecipe(r = {}) {
  return {
    id: r.id || uid('recipe'),
    name: r.name || '',
    category: r.category || 'ハンドメイド',
    components: Array.isArray(r.components) ? r.components.map(c => ({
      materialId: c.materialId || '',
      qty: Number(c.qty ?? 0),
      memo: c.memo || ''
    })) : [],
    defaultLaborMinutes: Number(r.defaultLaborMinutes ?? 0),
    memo: r.memo || '',
    createdAt: r.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}

export function createProductionBatch(b = {}) {
  return {
    id: b.id || uid('batch'),
    recipeId: b.recipeId || '',
    date: b.date || '',
    outputQty: Number(b.outputQty ?? 1),
    badQty: Number(b.badQty ?? 0),
    consumedMaterials: Array.isArray(b.consumedMaterials) ? b.consumedMaterials : [],
    directCost: Number(b.directCost ?? 0),
    memo: b.memo || '',
    createdInventoryIds: Array.isArray(b.createdInventoryIds) ? b.createdInventoryIds : [],
    unitCost: Number(b.unitCost ?? 0),
    createdAt: b.createdAt || nowISO()
  };
}

export function createSalesChannel(c = {}) {
  return {
    id: c.id || uid('channel'),
    name: c.name || '',
    type: c.type || 'online',
    feeRate: Number(c.feeRate ?? 0),
    fixedFee: Number(c.fixedFee ?? 0),
    location: c.location || '',
    active: c.active !== false,
    memo: c.memo || '',
    createdAt: c.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}

export function createListingRecord(l = {}) {
  return {
    id: l.id || uid('listing'),
    inventoryId: l.inventoryId || '',
    channelId: l.channelId || '',
    listedAt: l.listedAt || '',
    listedPrice: Number(l.listedPrice ?? 0),
    status: l.status || 'listed',
    unlistedAt: l.unlistedAt || '',
    soldSaleId: l.soldSaleId || null,
    memo: l.memo || '',
    createdAt: l.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}

export function createEvent(e = {}) {
  return {
    id: e.id || uid('event'),
    channelId: e.channelId || '',
    eventName: e.eventName || e.name || '',
    eventDate: e.eventDate || e.date || '',
    location: e.location || '',
    boothFee: Number(e.boothFee ?? 0),
    transportCost: Number(e.transportCost ?? 0),
    otherCost: Number(e.otherCost ?? 0),
    memo: e.memo || '',
    createdAt: e.createdAt || nowISO(),
    updatedAt: nowISO()
  };
}
