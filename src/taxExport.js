import { saleProfit, inventoryValueAtYearEnd, materialStock, calcMaterialAverageCost } from './calc.js';
import { taxSummary } from './taxMode.js';
import { inYear, yen, num, csvEscape, makeCSV } from './utils.js';

const saleHeaders = ['販売日','商品名','商品種別','カテゴリ','販売先','売上','売上原価','販売手数料','送料','その他経費','実利益','利益率','メモ'];
const feeHeaders = ['日付','商品名','販売先','販売手数料','送料','合計','備考'];
const expenseHeaders = ['日付','分類','申告向け分類','金額','支払先','メモ'];
const inventoryHeaders = ['商品ID','商品名','商品種別','カテゴリ','ステータス','数量','単価原価','在庫評価額','仕入日/制作日','メモ'];
const materialHeaders = ['購入日','材料名','カテゴリ','数量','単位','金額','購入先','メモ'];
const batchHeaders = ['制作日','レシピ名','完成数量','不良数','材料消費額','直接費','1点原価','作成在庫数','メモ'];
const summaryHeaders = ['項目','金額/値','補足'];

export function taxExportRows(data, year) {
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  const channels = Object.fromEntries((data.salesChannels || []).map(c => [c.id, c.name]));
  const recipeById = Object.fromEntries((data.recipes || []).map(r => [r.id, r]));
  const taxMap = Object.fromEntries((data.taxMappings || []).map(m => [m.expenseCategory, m.taxCategory]));

  const sales = data.sales.filter(s => inYear(s.soldAt, year)).map(s => {
    const inv = invById[s.inventoryId];
    const c = saleProfit(s, inv);
    return {
      '販売日': s.soldAt || '',
      '商品名': inv?.name || '',
      '商品種別': inv?.productType || '',
      'カテゴリ': inv?.productCategory || inv?.handmadeLine || '',
      '販売先': channels[s.channelId] || s.platform || '',
      '売上': Math.round(c.gross),
      '売上原価': Math.round(c.cost),
      '販売手数料': Math.round(c.fee),
      '送料': Math.round(c.shipping),
      'その他経費': Math.round(c.extra),
      '実利益': Math.round(c.profit),
      '利益率': c.margin.toFixed(1),
      'メモ': s.memo || ''
    };
  });

  const fees = data.sales.filter(s => inYear(s.soldAt, year)).map(s => {
    const inv = invById[s.inventoryId];
    const fee = num(s.fee);
    const shipping = num(s.shipping);
    return {
      '日付': s.soldAt || '',
      '商品名': inv?.name || '',
      '販売先': channels[s.channelId] || s.platform || '',
      '販売手数料': Math.round(fee),
      '送料': Math.round(shipping),
      '合計': Math.round(fee + shipping),
      '備考': s.memo || ''
    };
  });

  const expenses = data.expenses.filter(e => inYear(e.date, year)).map(e => ({
    '日付': e.date || '',
    '分類': e.category || '未分類',
    '申告向け分類': e.taxCategory || taxMap[e.category] || '未分類',
    '金額': Math.round(num(e.amount)),
    '支払先': e.vendor || '',
    'メモ': e.memo || ''
  }));

  const soldIdsThroughYear = new Set(data.sales.filter(s => s.soldAt && String(s.soldAt) <= `${year}-12-31`).map(s => s.inventoryId));
  const inventory = data.inventories.filter(i => !soldIdsThroughYear.has(i.id)).map(i => ({
    '商品ID': i.id,
    '商品名': i.name || '',
    '商品種別': i.productType || 'resale',
    'カテゴリ': i.productCategory || i.handmadeLine || '',
    'ステータス': i.status || '',
    '数量': num(i.quantity) || 1,
    '単価原価': Math.round(num(i.costPrice)),
    '在庫評価額': Math.round(num(i.costPrice) * (num(i.quantity) || 1)),
    '仕入日/制作日': i.purchasedAt || '',
    'メモ': i.notes || ''
  }));

  const materialPurchases = data.materialPurchases.filter(p => inYear(p.date, year)).map(p => {
    const mat = data.materials.find(m => m.id === p.materialId);
    return {
      '購入日': p.date || '',
      '材料名': mat?.name || '',
      'カテゴリ': mat?.category || '',
      '数量': num(p.qty),
      '単位': mat?.unit || '',
      '金額': Math.round(num(p.amount)),
      '購入先': p.vendor || '',
      'メモ': p.memo || ''
    };
  });

  const batches = data.productionBatches.filter(b => inYear(b.date, year)).map(b => {
    const recipe = recipeById[b.recipeId];
    const materialCost = (b.consumedMaterials || []).reduce((sum, c) => sum + num(c.amount), 0);
    return {
      '制作日': b.date || '',
      'レシピ名': recipe?.name || '',
      '完成数量': num(b.outputQty),
      '不良数': num(b.badQty),
      '材料消費額': Math.round(materialCost),
      '直接費': Math.round(num(b.directCost)),
      '1点原価': Math.round(num(b.unitCost)),
      '作成在庫数': (b.createdInventoryIds || []).length,
      'メモ': b.memo || ''
    };
  });

  const s = taxSummary(data, year);
  const summary = [
    { '項目': '対象年', '金額/値': year, '補足': '' },
    { '項目': '年間売上', '金額/値': Math.round(s.salesTotal), '補足': '販売明細の売上合計' },
    { '項目': '売上原価', '金額/値': Math.round(s.costOfGoodsSold), '補足': '販売済み商品の原価合計' },
    { '項目': '粗利益', '金額/値': Math.round(s.grossProfit), '補足': '売上 - 売上原価' },
    { '項目': '必要経費', '金額/値': Math.round(s.expenses), '補足': '経費明細の合計' },
    { '項目': '実利益', '金額/値': Math.round(s.netProfit), '補足': 'NoirStock集計値' },
    { '項目': '期末在庫評価額', '金額/値': Math.round(s.endingInventoryValue), '補足': '年末時点の未販売在庫' },
    { '項目': '材料残評価額', '金額/値': Math.round(s.endingMaterialValue), '補足': '材料残量×平均単価' },
    { '項目': '販売手数料合計', '金額/値': Math.round(s.feeTotal), '補足': '' },
    { '項目': '送料合計', '金額/値': Math.round(s.shippingTotal), '補足': '' }
  ];

  return { sales, fees, expenses, inventory, materialPurchases, batches, summary };
}

export function taxCsvFiles(data, year) {
  const rows = taxExportRows(data, year);
  return [
    { filename: `noirstock_${year}_01_売上明細.csv`, csv: '\ufeff' + makeCSV(saleHeaders, rows.sales) },
    { filename: `noirstock_${year}_02_販売手数料送料.csv`, csv: '\ufeff' + makeCSV(feeHeaders, rows.fees) },
    { filename: `noirstock_${year}_03_経費明細.csv`, csv: '\ufeff' + makeCSV(expenseHeaders, rows.expenses) },
    { filename: `noirstock_${year}_04_在庫棚卸.csv`, csv: '\ufeff' + makeCSV(inventoryHeaders, rows.inventory) },
    { filename: `noirstock_${year}_05_材料購入.csv`, csv: '\ufeff' + makeCSV(materialHeaders, rows.materialPurchases) },
    { filename: `noirstock_${year}_06_制作ロット.csv`, csv: '\ufeff' + makeCSV(batchHeaders, rows.batches) },
    { filename: `noirstock_${year}_07_申告入力補助表.csv`, csv: '\ufeff' + makeCSV(summaryHeaders, rows.summary) }
  ];
}

export function taxHelperHtml(data, year) {
  const rows = taxExportRows(data, year);
  const summary = rows.summary;
  const tr = summary.map(r => `<tr><th>${r['項目']}</th><td>${r['金額/値']}</td><td>${r['補足'] || ''}</td></tr>`).join('');
  const salesCount = rows.sales.length;
  const expenseCount = rows.expenses.length;
  const inventoryCount = rows.inventory.length;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NoirStock ${year} 申告入力補助表</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;background:#f7f1e7;color:#2e2a24;margin:0;padding:24px}
main{max-width:920px;margin:auto;background:#fffdf8;border:1px solid #e4d8c6;border-radius:22px;padding:24px;box-shadow:0 18px 36px rgba(75,62,43,.12)}
h1{margin:0 0 4px} .muted{color:#81786a}
table{width:100%;border-collapse:collapse;margin-top:18px} th,td{border:1px solid #e4d8c6;padding:10px;text-align:left} th{background:#f1e8d8;width:28%}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.card{background:#f1e8d8;border-radius:16px;padding:14px}
.num{font-size:1.5rem;font-weight:800;color:#4f805e}
.note{margin-top:20px;padding:14px;border-radius:16px;background:#fff5dc}
@media print{body{background:white;padding:0}main{box-shadow:none;border:none}.note{page-break-inside:avoid}}
</style>
</head>
<body>
<main>
<h1>NoirStock ${year} 申告入力補助表</h1>
<p class="muted">この表は確定申告入力の補助用です。最終的な申告区分・科目判断はご自身で確認してください。</p>
<div class="cards">
<div class="card"><div>販売件数</div><div class="num">${salesCount}</div></div>
<div class="card"><div>経費件数</div><div class="num">${expenseCount}</div></div>
<div class="card"><div>期末在庫件数</div><div class="num">${inventoryCount}</div></div>
</div>
<table><tbody>${tr}</tbody></table>
<div class="note">
<strong>確認メモ</strong><br>
売上、売上原価、経費、棚卸、材料購入、制作ロットをNoirStockのデータから集計しています。
国税庁の確定申告書等作成コーナーや会計ソフトへ転記する前に、未分類経費・棚卸・証跡を確認してください。
</div>
</main>
</body>
</html>`;
}
