import { safeNum } from './utils.js';
import { countDataset } from './schema.js';

function issue(severity, code, message, item = {}) {
  return { severity, code, message, ...item };
}

export function validateDataset(dataset = {}) {
  const inventory = dataset.inventory || dataset.inventories || [];
  const sales = dataset.sales || [];
  const expenses = dataset.expenses || [];
  const ocrRecords = dataset.ocrRecords || [];
  const warnings = [];
  const errors = [];

  if (!Array.isArray(inventory)) errors.push(issue('error', 'inventory_not_array', '在庫データが配列ではありません。'));
  if (!Array.isArray(sales)) errors.push(issue('error', 'sales_not_array', '販売データが配列ではありません。'));
  if (!Array.isArray(expenses)) errors.push(issue('error', 'expenses_not_array', '経費データが配列ではありません。'));

  const invRows = Array.isArray(inventory) ? inventory : [];
  const saleRows = Array.isArray(sales) ? sales : [];
  const expenseRows = Array.isArray(expenses) ? expenses : [];
  const ocrRows = Array.isArray(ocrRecords) ? ocrRecords : [];

  const inventoryIds = new Set();
  invRows.forEach((item, idx) => {
    if (!item.id) warnings.push(issue('warning', 'inventory_missing_id', `在庫${idx + 1}件目にIDがありません。補完対象です。`, { type: 'inventory', row: idx + 1 }));
    if (item.id && inventoryIds.has(item.id)) warnings.push(issue('warning', 'inventory_duplicate_id', `在庫IDが重複しています: ${item.id}`, { type: 'inventory', id: item.id }));
    if (item.id) inventoryIds.add(item.id);
    if (!item.name) warnings.push(issue('warning', 'inventory_missing_name', '商品名が空の在庫があります。', { type: 'inventory', id: item.id || '' }));
    if (!safeNum(item.purchasePrice)) warnings.push(issue('warning', 'inventory_missing_purchase_price', `仕入れ値未入力: ${item.name || item.id || '無題在庫'}`, { type: 'inventory', id: item.id || '' }));
    if (!item.purchaseDate) warnings.push(issue('warning', 'inventory_missing_purchase_date', `仕入日未入力: ${item.name || item.id || '無題在庫'}`, { type: 'inventory', id: item.id || '' }));
  });

  saleRows.forEach((sale, idx) => {
    if (!sale.id) warnings.push(issue('warning', 'sale_missing_id', `販売${idx + 1}件目にIDがありません。補完対象です。`, { type: 'sale', row: idx + 1 }));
    if (!sale.inventoryId) warnings.push(issue('warning', 'sale_missing_inventory_id', `販売データに在庫紐付けがありません: ${sale.id || idx + 1}`, { type: 'sale', id: sale.id || '' }));
    if (sale.inventoryId && !inventoryIds.has(sale.inventoryId)) warnings.push(issue('warning', 'sale_orphan_inventory_id', `販売データの在庫IDが見つかりません: ${sale.inventoryId}`, { type: 'sale', id: sale.id || '' }));
    if (!sale.saleDate) warnings.push(issue('warning', 'sale_missing_date', `販売日未入力: ${sale.id || idx + 1}`, { type: 'sale', id: sale.id || '' }));
    if (!safeNum(sale.salePrice)) warnings.push(issue('warning', 'sale_missing_price', `販売単価未入力: ${sale.id || idx + 1}`, { type: 'sale', id: sale.id || '' }));
    if (sale.proofImageDataUrl && !sale.externalItemId && !sale.ocrRecordId) warnings.push(issue('warning', 'ocr_unconfirmed', `OCR未確定候補: ${sale.id || idx + 1}`, { type: 'sale', id: sale.id || '' }));
  });

  expenseRows.forEach((expense, idx) => {
    if (!expense.id) warnings.push(issue('warning', 'expense_missing_id', `経費${idx + 1}件目にIDがありません。補完対象です。`, { type: 'expense', row: idx + 1 }));
    if (!expense.date) warnings.push(issue('warning', 'expense_missing_date', `経費の日付が空です: ${expense.title || expense.category || idx + 1}`, { type: 'expense', id: expense.id || '' }));
    if (!safeNum(expense.amount)) warnings.push(issue('warning', 'expense_missing_amount', `経費金額が空です: ${expense.title || expense.category || idx + 1}`, { type: 'expense', id: expense.id || '' }));
  });

  ocrRows.forEach((row, idx) => {
    if (!row.status) warnings.push(issue('warning', 'ocr_missing_status', `OCRレコード${idx + 1}件目に状態がありません。`, { type: 'ocr', id: row.id || '' }));
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: countDataset(dataset),
  };
}

export function splitIssues(report = {}) {
  return {
    errors: report.errors || [],
    warnings: report.warnings || [],
  };
}
