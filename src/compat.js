import {
  APP_SCHEMA_VERSION,
  createEmptyDataset,
  createInventory,
  createSale,
  createExpense,
  createMaterial,
  createMaterialPurchase,
  createRecipe,
  createProductionBatch,
  createSalesChannel,
  createListingRecord,
  createEvent,
  defaultTaxSettings,
  defaultTaxMappings
} from './schema.js';
import { deepClone, num, normalizeDate, nowISO } from './utils.js';

const arr = v => Array.isArray(v) ? v : [];

export function detectJsonShape(data) {
  if (!data || typeof data !== 'object') return 'invalid';
  if (data.schemaVersion) return `schema:${data.schemaVersion}`;
  if (data.inventories || data.sales || data.expenses) return 'legacy-no-schema';
  if (data.items || data.products || data.transactions) return 'migration-legacy';
  return 'unknown';
}

export function normalizeToV64(data) {
  if (!data || typeof data !== 'object') throw new Error('JSONの形式が正しくありません。');
  const b = createEmptyDataset();
  const s = deepClone(data);

  b.app = s.app || 'NoirStock';
  b.schemaVersion = APP_SCHEMA_VERSION;
  b.createdAt = s.createdAt || nowISO();
  b.updatedAt = nowISO();

  const inv = arr(s.inventories || s.inventory || s.items || s.products);
  b.inventories = inv.map(i => createInventory({
    ...i,
    productType: i.productType || 'resale',
    productCategory: i.productCategory || '',
    handmadeLine: i.handmadeLine || '',
    currentListingIds: arr(i.currentListingIds),
    costPrice: num(i.costPrice ?? i.purchasePrice ?? i.cost ?? i['仕入れ値']),
    expectedPrice: num(i.expectedPrice ?? i.expectedSalePrice ?? i['想定売価']),
    quantity: num(i.quantity ?? i.qty ?? 1) || 1,
    purchasedAt: normalizeDate(i.purchasedAt || i.purchaseDate || i.date)
  }));

  const sales = arr(s.sales || s.saleRecords || s.soldItems || s.transactions);
  b.sales = sales.map(x => createSale({
    ...x,
    grossPrice: num(x.grossPrice ?? x.salePrice ?? x.price ?? x['販売単価']),
    fee: num(x.fee ?? x.commission ?? x['販売手数料']),
    shipping: num(x.shipping ?? x.postage ?? x['送料']),
    extraCost: num(x.extraCost ?? x.additionalCost),
    costPrice: num(x.costPrice ?? x.cost),
    soldAt: normalizeDate(x.soldAt || x.saleDate || x.date || x['販売日']),
    channelId: x.channelId || '',
    listingRecordId: x.listingRecordId || '',
    eventId: x.eventId || ''
  }));

  b.expenses = arr(s.expenses || s.costs || s.expenseRecords).map(e => createExpense({
    ...e,
    amount: num(e.amount ?? e.price ?? e['金額']),
    date: normalizeDate(e.date || e.expenseDate)
  }));

  b.ocrRecords = arr(s.ocrRecords);
  b.materials = arr(s.materials).map(createMaterial);
  b.materialPurchases = arr(s.materialPurchases).map(p => createMaterialPurchase({
    ...p,
    qty: num(p.qty),
    amount: num(p.amount),
    date: normalizeDate(p.date)
  }));
  b.recipes = arr(s.recipes).map(createRecipe);
  b.productionBatches = arr(s.productionBatches).map(p => createProductionBatch({
    ...p,
    outputQty: num(p.outputQty) || 1,
    badQty: num(p.badQty),
    directCost: num(p.directCost),
    date: normalizeDate(p.date)
  }));
  b.inventoryMovements = arr(s.inventoryMovements);

  b.salesChannels = arr(s.salesChannels).map(c => createSalesChannel({
    ...c,
    feeRate: num(c.feeRate),
    fixedFee: num(c.fixedFee)
  }));
  b.listingRecords = arr(s.listingRecords).map(l => createListingRecord({
    ...l,
    listedAt: normalizeDate(l.listedAt),
    unlistedAt: normalizeDate(l.unlistedAt),
    listedPrice: num(l.listedPrice)
  }));
  b.events = arr(s.events).map(e => createEvent({
    ...e,
    eventDate: normalizeDate(e.eventDate || e.date),
    boothFee: num(e.boothFee),
    transportCost: num(e.transportCost),
    otherCost: num(e.otherCost)
  }));

  b.taxSettings = { ...defaultTaxSettings(), ...(s.taxSettings || {}) };
  b.taxMappings = arr(s.taxMappings).length ? s.taxMappings : defaultTaxMappings();
  b.meta = { ...(s.meta || {}), normalizedFrom: detectJsonShape(s), normalizedAt: nowISO() };
  return b;
}
