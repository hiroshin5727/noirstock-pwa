import { materialStock } from './calc.js';
import { taxChecklist } from './taxMode.js';
import { staleListings } from './analytics.js';

export function validateDataset(data) {
  const warnings = [];
  const errors = [];
  if (!Array.isArray(data.inventories)) errors.push('inventories が配列ではありません。');
  if (!Array.isArray(data.sales)) errors.push('sales が配列ではありません。');
  if (!Array.isArray(data.expenses)) errors.push('expenses が配列ではありません。');
  for (const inv of data.inventories || []) {
    if (!inv.name) warnings.push({ targetType: 'inventory', targetId: inv.id, message: '商品名未入力の在庫があります。' });
    if (inv.status === 'sold' && !inv.costPrice) warnings.push({ targetType: 'inventory', targetId: inv.id, message: `販売済み商品の原価未入力: ${inv.name || inv.id}` });
  }
  for (const sale of data.sales || []) {
    if (!sale.channelId) warnings.push({ targetType: 'sale', targetId: sale.id, message: '販売場所未設定の販売があります。' });
  }
  for (const listing of data.listingRecords || []) {
    if (!listing.channelId) warnings.push({ targetType: 'listing', targetId: listing.id, message: '出品先未設定の出品履歴があります。' });
    if (listing.status === 'listed' && !listing.listedAt) warnings.push({ targetType: 'listing', targetId: listing.id, message: '出品日未入力の出品履歴があります。' });
  }
  for (const mat of data.materials || []) {
    const stock = materialStock(data, mat.id);
    if (stock < 0) warnings.push({ targetType: 'material', targetId: mat.id, message: `材料残量がマイナスです: ${mat.name}` });
  }
  for (const stale of staleListings(data).filter(x => (x.days || 0) >= 60)) {
    warnings.push({ targetType: 'listing', targetId: stale.id, message: `長期出品中: ${stale.itemName} / ${stale.channelName} / ${stale.days}日` });
  }
  return { warnings, errors };
}

export function buildReviewItems(data) {
  const year = data.taxSettings?.year || new Date().getFullYear();
  return [
    ...validateDataset(data).warnings.map(w => ({ severity: 'warning', ...w })),
    ...taxChecklist(data, year)
  ];
}
