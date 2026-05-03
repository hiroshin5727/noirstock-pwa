import { getDataset, patchDataset, replaceDataset, createAutoBackup, resetDataset } from './db.js';
import { normalizeToV64 } from './compat.js';
import { validateDataset, buildReviewItems } from './validator.js';
import { createInventory, createSale, createExpense, createMaterial, createMaterialPurchase, createRecipe } from './schema.js';
import { yen, pct, num, todayISO, escapeHtml, downloadText, readFileAsText, makeCSV } from './utils.js';
import { saleProfit, calcSummary, recipeEstimatedUnitCost, materialStock, calcMaterialAverageCost } from './calc.js';
import { createBatchAndInventories } from './handmade.js';
import { taxSummary, taxChecklist, expenseCategoryRows } from './taxMode.js';
import { taxCsvFiles, taxHelperHtml } from './taxExport.js';
import { channelTypeText, listingStatusText, addSalesChannel, addListingRecord, addEventRecord, markListingSold, unlistListing, archiveSalesChannel, restoreSalesChannel, activeListingsForInventory } from './listing.js';
import { channelStats, eventStats, staleListings, listingLeadTimeStats, priceRangeStats, categoryStats, monthlyTrendStats, topProductsByProfit, handmadeOnlyStats } from './analytics.js';

const app = document.getElementById('app');
let state = { view: 'home', filter: 'all', year: new Date().getFullYear() };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);

const data = () => getDataset();

function downloadBlobFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportTaxCsvSet() {
  const d = data();
  const files = taxCsvFiles(d, state.year);
  for (const file of files) {
    downloadBlobFile(file.filename, new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  toast('申告CSV一式を出力しました');
}

function exportTaxHelperHtml() {
  const html = taxHelperHtml(data(), state.year);
  downloadBlobFile(`noirstock_${state.year}_申告入力補助表.html`, new Blob([html], { type: 'text/html;charset=utf-8' }));
  toast('申告入力補助表HTMLを出力しました');
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const statusText = s => ({ stock: '在庫中', listed: '出品中', sold: '販売済', hold: '保留', review: '要確認' }[s] || s || '在庫中');
const productTypeText = t => ({ resale: '仕入販売品', handmade: 'ハンドメイド', hybrid: 'ハイブリッド' }[t] || '仕入販売品');

function yearOptions() {
  const years = new Set([new Date().getFullYear()]);
  data().sales.forEach(s => { if (s.soldAt) years.add(Number(String(s.soldAt).slice(0, 4))); });
  data().expenses.forEach(e => { if (e.date) years.add(Number(String(e.date).slice(0, 4))); });
  data().events.forEach(e => { if (e.eventDate) years.add(Number(String(e.eventDate).slice(0, 4))); });
  return [...years].filter(Boolean).sort((a, b) => b - a).map(y => `<option value="${y}" ${Number(state.year) === Number(y) ? 'selected' : ''}>${y}年</option>`).join('');
}

function render() {
  app.innerHTML = `
    <div class="app">
      <header class="header">
        <div>
          <div class="brand">NoirStock <span class="badge">v6.5.0</span></div>
          <div class="sub">Handmade / Listing / Analysis</div>
        </div>
        <div class="header-actions">
          <button class="btn ghost" data-action="open-expense">経費</button>
          <button class="btn ghost" data-action="open-settings">設定</button>
        </div>
      </header>
      ${viewHtml(data())}
    </div>
    ${tabsHtml()}
  `;
  bind();
}

function tabsHtml() {
  const tabs = [['home', '⌂', 'ホーム'], ['inventory', '▣', '在庫'], ['register', '＋', '登録'], ['sales', '🛒', '販売'], ['analysis', '▥', '分析']];
  return `<nav class="tabs">${tabs.map(t => `<button class="tab ${state.view === t[0] ? 'active' : ''}" data-view="${t[0]}"><span class="ico">${t[1]}</span><span class="label">${t[2]}</span></button>`).join('')}</nav>`;
}

function viewHtml(d) {
  if (state.view === 'inventory') return inventoryView(d);
  if (state.view === 'register') return registerView(d);
  if (state.view === 'sales') return salesView(d);
  if (state.view === 'analysis') return analysisView(d);
  return homeView(d);
}

function homeView(d) {
  const s = calcSummary(d, 'year', state.year);
  const reviews = buildReviewItems(d).slice(0, 6);
  const recent = d.sales.slice().sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt))).slice(0, 4);
  const stale = staleListings(d).slice(0, 3);
  return `
    <main class="grid">
      <div class="row wrap">
        <div><h1 class="screen-title">ホーム</h1><div class="muted">今日の作業・売上・出品状況</div></div>
        <select style="max-width:180px" data-action="change-year">${yearOptions()}</select>
      </div>
      <section class="kpi grid">
        <div class="panel"><div class="muted">年間売上</div><div class="money">${yen(s.salesTotal)}</div><div>${s.salesCount}件</div></div>
        <div class="panel"><div class="muted">年間実利益</div><div class="money">${yen(s.profit)}</div><div>経費込</div></div>
        <div class="panel"><div class="muted">出品中</div><div class="money">${d.listingRecords.filter(l => l.status === 'listed').length}</div><div>商品</div></div>
      </section>
      <section class="panel">
        <div class="row"><h2>要確認</h2><button class="btn ghost" data-view="analysis">分析へ</button></div>
        <div class="card-list">${reviews.length ? reviews.map(reviewCard).join('') : '<div class="muted">要確認はありません。</div>'}</div>
      </section>
      <section class="panel">
        <div class="row"><h2>長期出品中</h2><button class="btn ghost" data-view="inventory">在庫へ</button></div>
        <div class="card-list">${stale.length ? stale.map(staleCard).join('') : '<div class="muted">長期出品中の商品はありません。</div>'}</div>
      </section>
      <section class="panel">
        <div class="row"><h2>最近の販売</h2><button class="btn ghost" data-view="sales">もっと見る</button></div>
        <div class="card-list">${recent.length ? recent.map(saleCard).join('') : '<div class="muted">販売履歴はまだありません。</div>'}</div>
      </section>
    </main>`;
}

function reviewCard(r) {
  return `<div class="item-card"><div class="row"><div><span class="pill ${r.severity === 'danger' ? 'red' : 'amber'}">${r.severity || 'warning'}</span><div style="margin-top:8px">${escapeHtml(r.message)}</div></div><button class="btn ghost" data-jump-type="${r.targetType}" data-jump-id="${r.targetId}">開く</button></div></div>`;
}

function staleCard(l) {
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(l.itemName)}</div><div class="muted">${escapeHtml(l.channelName)} / ${l.listedAt || '-'} から ${l.days ?? '-'}日</div></div><span class="pill amber">出品中</span></div></div>`;
}

function saleCard(sale) {
  const d = data();
  const inv = d.inventories.find(i => i.id === sale.inventoryId);
  const ch = d.salesChannels.find(c => c.id === sale.channelId);
  const ev = d.events.find(e => e.id === sale.eventId);
  const c = saleProfit(sale, inv);
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(inv?.name || sale.memo || '販売')}</div><div class="muted">${sale.soldAt || '-'} / ${escapeHtml(ch?.name || sale.platform || '未設定')}${ev ? ' / ' + escapeHtml(ev.eventName) : ''}</div></div><div style="text-align:right"><div class="money" style="font-size:1.5rem">${yen(c.profit)}</div><div class="muted">${yen(c.gross)}</div></div></div></div>`;
}

function inventoryView(d) {
  const list = d.inventories.filter(i => state.filter === 'all' || i.productType === state.filter);
  return `<main class="grid">
    <div class="row wrap"><div><h1 class="screen-title">在庫</h1><div class="muted">商品・完成品・出品状況を管理</div></div><button class="btn primary" data-action="open-inventory">在庫追加</button></div>
    <div class="section-actions">${['all', 'resale', 'handmade', 'hybrid'].map(f => `<button class="chip ${state.filter === f ? 'active' : ''}" data-filter="${f}">${f === 'all' ? 'すべて' : productTypeText(f)}</button>`).join('')}</div>
    <section class="card-list">${list.length ? list.map(invCard).join('') : '<div class="panel muted">在庫はありません。</div>'}</section>
  </main>`;
}

function listingBadges(inv) {
  const d = data();
  const listings = activeListingsForInventory(d, inv.id);
  if (!listings.length) return '<span class="pill amber">未出品</span>';
  return listings.map(l => {
    const ch = d.salesChannels.find(c => c.id === l.channelId);
    return `<span class="pill blue">${escapeHtml(ch?.name || '未設定')} 出品中</span>`;
  }).join('');
}

function invCard(inv) {
  const active = activeListingsForInventory(data(), inv.id);
  return `<div class="item-card">
    <div class="row wrap">
      <div><div class="name">${escapeHtml(inv.name || '名称未入力')}</div><div class="muted">${escapeHtml(inv.brand || '')} ${escapeHtml(inv.size || '')}</div></div>
      <div class="section-actions"><span class="pill ${inv.productType === 'handmade' ? 'purple' : 'blue'}">${productTypeText(inv.productType)}</span><span class="pill ${inv.status === 'sold' ? 'green' : 'amber'}">${statusText(inv.status)}</span></div>
    </div>
    <div class="section-actions">${listingBadges(inv)}</div>
    <div class="finance">
      <div><span>原価</span><strong>${yen(inv.costPrice)}</strong></div>
      <div><span>想定売価</span><strong>${yen(inv.expectedPrice)}</strong></div>
      <div><span>出品数</span><strong>${active.length}</strong></div>
    </div>
    <div class="row wrap">
      <select data-status-id="${inv.id}" style="max-width:180px">${['stock', 'listed', 'sold', 'hold', 'review'].map(s => `<option value="${s}" ${inv.status === s ? 'selected' : ''}>${statusText(s)}</option>`).join('')}</select>
      <div class="section-actions">
        <button class="btn blue" data-action="save-status" data-id="${inv.id}">変更</button>
        <button class="btn ghost" data-action="open-listing" data-id="${inv.id}">出品する</button>
        <button class="btn ghost" data-action="open-sale" data-id="${inv.id}">販売入力</button>
      </div>
    </div>
  </div>`;
}

function registerView(d) {
  return `<main class="grid">
    <h1 class="screen-title">登録</h1>
    <section class="panel">
      <h2>基本登録</h2>
      <div class="section-actions">
        <button class="btn primary" data-action="open-inventory">在庫追加</button>
        <button class="btn ghost" data-action="open-expense">経費追加</button>
      </div>
    </section>
    <section class="panel">
      <h2>ハンドメイド</h2>
      <div class="section-actions">
        <button class="btn blue" data-action="open-material">材料追加</button>
        <button class="btn blue" data-action="open-material-purchase">材料購入</button>
        <button class="btn blue" data-action="open-recipe">レシピ/BOM</button>
        <button class="btn primary" data-action="open-batch">制作ロット</button>
      </div>
    </section>
    <section class="panel">
      <h2>出品・イベント</h2>
      <div class="section-actions">
        <button class="btn blue" data-action="open-channel">出品先追加</button>
        <button class="btn blue" data-action="open-event">イベント追加</button>
      </div>
    </section>
    <section class="panel">
      <div class="row"><h2>出品先</h2><span class="muted">${d.salesChannels.length}件</span></div>
      <div class="card-list">${d.salesChannels.length ? d.salesChannels.map(channelCard).join('') : '<div class="muted">出品先はまだありません。</div>'}</div>
    </section>
    <section class="panel">
      <div class="row"><h2>イベント</h2><span class="muted">${d.events.length}件</span></div>
      <div class="card-list">${d.events.length ? d.events.map(eventCard).join('') : '<div class="muted">イベントはまだありません。</div>'}</div>
    </section>
    <section class="panel">
      <div class="row"><h2>出品履歴</h2><span class="muted">${d.listingRecords.length}件</span></div>
      <div class="card-list">${d.listingRecords.length ? d.listingRecords.slice().reverse().slice(0,12).map(listingCard).join('') : '<div class="muted">出品履歴はまだありません。</div>'}</div>
    </section>
    <section class="panel">
      <div class="row"><h2>材料</h2><span class="muted">${d.materials.length}件</span></div>
      <div class="card-list">${d.materials.length ? d.materials.map(materialCard).join('') : '<div class="muted">材料はまだありません。</div>'}</div>
    </section>
    <section class="panel">
      <div class="row"><h2>レシピ</h2><span class="muted">${d.recipes.length}件</span></div>
      <div class="card-list">${d.recipes.length ? d.recipes.map(recipeCard).join('') : '<div class="muted">レシピはまだありません。</div>'}</div>
    </section>
  </main>`;
}

function channelCard(c) {
  return `<div class="item-card"><div class="row wrap"><div><div class="name">${escapeHtml(c.name)}</div><div class="muted">${channelTypeText(c.type)} / 手数料 ${c.feeRate || 0}% / 固定 ${yen(c.fixedFee)} ${c.location ? '/ ' + escapeHtml(c.location) : ''}</div></div><div class="section-actions"><span class="pill ${c.active ? 'green' : 'amber'}">${c.active ? '利用中' : '停止'}</span><button class="btn ghost" data-action="${c.active ? 'archive-channel' : 'restore-channel'}" data-id="${c.id}">${c.active ? '停止' : '再開'}</button></div></div></div>`;
}

function listingCard(l) {
  const d = data();
  const inv = d.inventories.find(i => i.id === l.inventoryId);
  const ch = d.salesChannels.find(c => c.id === l.channelId);
  return `<div class="item-card"><div class="row wrap"><div><div class="name">${escapeHtml(inv?.name || '不明商品')}</div><div class="muted">${escapeHtml(ch?.name || '未設定')} / ${l.listedAt || '-'} / ${yen(l.listedPrice)}</div></div><div class="section-actions"><span class="pill ${l.status === 'sold' ? 'green' : l.status === 'unlisted' ? 'amber' : 'blue'}">${listingStatusText(l.status)}</span>${l.status === 'listed' ? `<button class="btn ghost" data-action="unlist-listing" data-id="${l.id}">取り下げ</button>` : ''}</div></div>${l.memo ? `<div class="muted">${escapeHtml(l.memo)}</div>` : ''}</div>`;
}

function eventCard(e) {
  const ch = data().salesChannels.find(c => c.id === e.channelId);
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(e.eventName)}</div><div class="muted">${e.eventDate || '-'} / ${escapeHtml(e.location || '')} / ${escapeHtml(ch?.name || '')}</div></div><div>${yen(num(e.boothFee) + num(e.transportCost) + num(e.otherCost))}</div></div></div>`;
}

function materialCard(m) {
  const stock = materialStock(data(), m.id);
  const avg = calcMaterialAverageCost(data(), m.id);
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(m.name)}</div><div class="muted">${escapeHtml(m.category)} / ${escapeHtml(m.unit)}</div></div><span class="pill ${stock < 0 ? 'red' : 'green'}">残 ${stock.toFixed(2)} ${escapeHtml(m.unit)}</span></div><div class="muted">平均単価 ${yen(avg)}</div></div>`;
}

function recipeCard(r) {
  const c = recipeEstimatedUnitCost(data(), r);
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(r.name)}</div><div class="muted">材料 ${r.components.length}件 / 作業目安 ${r.defaultLaborMinutes || 0}分</div></div><div class="money" style="font-size:1.4rem">${yen(c)}</div></div></div>`;
}

function salesView(d) {
  return `<main class="grid">
    <div class="row wrap"><div><h1 class="screen-title">販売</h1><div class="muted">販売場所まで記録</div></div><button class="btn primary" data-action="open-sale">販売入力</button></div>
    <section class="card-list">${d.sales.length ? d.sales.slice().reverse().map(saleCard).join('') : '<div class="panel muted">販売履歴はありません。</div>'}</section>
  </main>`;
}


function barChart(rows, valueKey, labelKey = 'label', options = {}) {
  const max = Math.max(...rows.map(r => Math.abs(Number(r[valueKey] || 0))), 1);
  return `<div class="chart-bars">${rows.map(r => {
    const value = Number(r[valueKey] || 0);
    const h = Math.max(4, Math.round(Math.abs(value) / max * 100));
    return `<div class="chart-col"><div class="chart-value">${options.money ? yen(value) : value}</div><div class="chart-stick ${value < 0 ? 'negative' : ''}" style="height:${h}%"></div><div class="chart-label">${escapeHtml(r[labelKey])}</div></div>`;
  }).join('')}</div>`;
}

function horizontalBars(rows, valueKey, labelKey, options = {}) {
  const max = Math.max(...rows.map(r => Math.abs(Number(r[valueKey] || 0))), 1);
  return `<div class="hbars">${rows.map(r => {
    const value = Number(r[valueKey] || 0);
    const w = Math.max(4, Math.round(Math.abs(value) / max * 100));
    return `<div class="hbar-row"><div class="hbar-head"><b>${escapeHtml(r[labelKey])}</b><span>${options.money ? yen(value) : value}</span></div><div class="hbar-track"><span class="${value < 0 ? 'negative' : ''}" style="width:${w}%"></span></div>${options.sub ? `<div class="muted">${options.sub(r)}</div>` : ''}</div>`;
  }).join('')}</div>`;
}

function analysisView(d) {
  const tax = taxSummary(d, state.year);
  const checks = taxChecklist(d, state.year);
  const expenseRows = expenseCategoryRows(d, state.year);
  const chStats = channelStats(d, state.year);
  const evStats = eventStats(d, state.year);
  const stale = staleListings(d).slice(0, 8);
  const lead = listingLeadTimeStats(d);
  const monthly = monthlyTrendStats(d, state.year);
  const priceRows = priceRangeStats(d, state.year);
  const catRows = categoryStats(d, state.year);
  const topRows = topProductsByProfit(d, state.year, 6);
  const handmade = handmadeOnlyStats(d, state.year);

  return `<main class="grid">
    <div class="row wrap">
      <div><h1 class="screen-title">分析</h1><div class="muted">グラフで売上・利益・出品先を確認</div></div>
      <select style="max-width:180px" data-action="change-year">${yearOptions()}</select>
    </div>

    <section class="kpi grid">
      <div class="panel"><div class="muted">年間売上</div><div class="money">${yen(tax.salesTotal)}</div><div>${state.year}年</div></div>
      <div class="panel"><div class="muted">実利益</div><div class="money">${yen(tax.netProfit)}</div><div>${pct(tax.margin)}</div></div>
      <div class="panel"><div class="muted">ハンドメイド利益</div><div class="money">${yen(handmade.profit)}</div><div>${handmade.count}件 / ${pct(handmade.margin)}</div></div>
    </section>

    <section class="panel">
      <div class="row wrap"><h2>月別推移</h2><span class="muted">売上と利益を月ごとに確認</span></div>
      <div class="chart-card">
        <h3>月別売上</h3>
        ${barChart(monthly, 'sales', 'label', { money: true })}
      </div>
      <div class="chart-card">
        <h3>月別実利益</h3>
        ${barChart(monthly, 'profit', 'label', { money: true })}
      </div>
    </section>

    <section class="panel">
      <div class="row wrap"><h2>出品先別分析</h2><span class="muted">どこが売れて、どこが儲かるか</span></div>
      ${chStats.length ? horizontalBars(chStats, 'profit', 'name', { money: true, sub: r => `${r.count}件 / 売上 ${yen(r.sales)} / 利益率 ${pct(r.margin)}` }) : '<div class="muted">販売場所付きの販売データがまだありません。</div>'}
    </section>

    <section class="panel">
      <div class="row wrap"><h2>価格帯別販売数</h2><span class="muted">売れやすい価格帯</span></div>
      ${horizontalBars(priceRows, 'count', 'label', { sub: r => `売上 ${yen(r.sales)} / 利益 ${yen(r.profit)}` })}
    </section>

    <section class="panel">
      <div class="row wrap"><h2>カテゴリ別利益</h2><span class="muted">伸ばすべきジャンル</span></div>
      ${catRows.length ? horizontalBars(catRows, 'profit', 'category', { money: true, sub: r => `${r.count}件 / 売上 ${yen(r.sales)} / 利益率 ${pct(r.margin)}` }) : '<div class="muted">カテゴリ付き販売データはまだありません。</div>'}
    </section>

    <section class="panel">
      <div class="row wrap"><h2>利益上位商品</h2><span class="muted">利益を作っている商品</span></div>
      <div class="card-list">${topRows.length ? topRows.map(topProductCard).join('') : '<div class="muted">販売データがまだありません。</div>'}</div>
    </section>

    <section class="panel">
      <h2>イベント別収支</h2>
      <div class="card-list">${evStats.length ? evStats.map(eventStatCard).join('') : '<div class="muted">イベント販売データはまだありません。</div>'}</div>
    </section>

    <section class="panel">
      <h2>回転率・売れ残り</h2>
      <div class="finance">
        <div><span>平均 出品→販売</span><strong>${lead.avg.toFixed(1)}日</strong></div>
        <div><span>計算対象</span><strong>${lead.count}件</strong></div>
        <div><span>出品中</span><strong>${d.listingRecords.filter(l => l.status === 'listed').length}件</strong></div>
      </div>
      <div class="card-list" style="margin-top:12px">${stale.length ? stale.map(staleCard).join('') : '<div class="muted">出品中データはありません。</div>'}</div>
    </section>

    <section class="panel">
      <h2>申告モード</h2>
      <div class="finance">
        <div><span>売上原価</span><strong>${yen(tax.costOfGoodsSold)}</strong></div>
        <div><span>期末在庫</span><strong>${yen(tax.endingInventoryValue)}</strong></div>
        <div><span>材料残評価</span><strong>${yen(tax.endingMaterialValue)}</strong></div>
      </div>
      <div class="section-actions" style="margin-top:12px">
        <button class="btn primary" data-action="mark-inventory-checked">${state.year}年 棚卸確認済みにする</button>
        <button class="btn blue" data-action="export-tax-csv">申告CSV一式</button>
        <button class="btn ghost" data-action="export-tax-html">申告入力補助表HTML</button>
      </div>
    </section>

    <section class="panel">
      <h2>経費分類</h2>
      <div class="card-list">${expenseRows.length ? expenseRows.map(r => `<div class="item-card"><div class="row"><div><b>${escapeHtml(r.category)}</b><div class="muted">${escapeHtml(r.taxCategory)}</div></div><div>${yen(r.amount)} / ${r.count}件</div></div></div>`).join('') : '<div class="muted">経費はありません。</div>'}</div>
    </section>

    <section class="panel">
      <h2>申告前チェック</h2>
      <div class="card-list">${checks.length ? checks.map(reviewCard).join('') : '<div class="muted">チェック項目はありません。</div>'}</div>
    </section>
  </main>`;
}

function topProductCard(r) {
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(r.name)}</div><div class="muted">${productTypeText(r.productType)} / ${r.count}件 / 売上 ${yen(r.sales)}</div></div><div class="${r.profit >= 0 ? 'ok-text' : 'danger-text'}">${yen(r.profit)}</div></div></div>`;
}

function channelStatCard(r) {
  const max = Math.max(...channelStats(data(), state.year).map(x => x.sales), 1);
  const w = Math.max(4, Math.round(r.sales / max * 100));
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(r.name)}</div><div class="muted">${r.count}件 / 利益率 ${pct(r.margin)}</div></div><div style="text-align:right"><b>${yen(r.sales)}</b><div class="ok-text">${yen(r.profit)}</div></div></div><div class="bar"><span style="width:${w}%"></span></div></div>`;
}

function eventStatCard(r) {
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(r.name)}</div><div class="muted">${r.date || '-'} / ${r.count}件 / 費用 ${yen(r.eventCost)}</div></div><div style="text-align:right"><b>${yen(r.gross)}</b><div class="${r.net >= 0 ? 'ok-text' : 'danger-text'}">${yen(r.net)}</div></div></div></div>`;
}

function priceRangeCard(r) {
  const max = Math.max(...priceRangeStats(data(), state.year).map(x => x.count), 1);
  const w = Math.max(4, Math.round(r.count / max * 100));
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(r.label)}</div><div class="muted">${r.count}件 / 売上 ${yen(r.sales)}</div></div><div class="${r.profit >= 0 ? 'ok-text' : 'danger-text'}">${yen(r.profit)}</div></div><div class="bar"><span style="width:${w}%"></span></div></div>`;
}

function categoryStatCard(r) {
  const max = Math.max(...categoryStats(data(), state.year).map(x => x.profit), 1);
  const w = Math.max(4, Math.round(Math.max(0, r.profit) / max * 100));
  return `<div class="item-card"><div class="row"><div><div class="name">${escapeHtml(r.category)}</div><div class="muted">${r.count}件 / 利益率 ${pct(r.margin)}</div></div><div style="text-align:right"><b>${yen(r.sales)}</b><div class="${r.profit >= 0 ? 'ok-text' : 'danger-text'}">${yen(r.profit)}</div></div></div><div class="bar"><span style="width:${w}%"></span></div></div>`;
}

function bind() {
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; render(); }));
  document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.filter; render(); }));
  document.querySelectorAll('[data-action]').forEach(b => {
    if (b.dataset.action === 'change-year') return;
    b.addEventListener('click', e => handleAction(e, b.dataset.action, b));
  });
  document.querySelectorAll('[data-jump-type]').forEach(b => b.addEventListener('click', () => jumpTo(b.dataset.jumpType, b.dataset.jumpId)));
  document.querySelectorAll('[data-action="change-year"]').forEach(sel => sel.addEventListener('change', () => { state.year = Number(sel.value); render(); }));
}

function handleAction(e, action, el) {
  const id = el.dataset.id;
  if (action === 'open-inventory') return openInventoryModal();
  if (action === 'open-sale') return openSaleModal(id || '');
  if (action === 'open-expense') return openExpenseModal();
  if (action === 'open-settings') return openSettingsModal();
  if (action === 'save-status') return saveStatus(id);
  if (action === 'open-material') return openMaterialModal();
  if (action === 'open-material-purchase') return openMaterialPurchaseModal();
  if (action === 'open-recipe') return openRecipeModal();
  if (action === 'open-batch') return openBatchModal();
  if (action === 'open-channel') return openChannelModal();
  if (action === 'open-listing') return openListingModal(id || '');
  if (action === 'open-event') return openEventModal();
  if (action === 'archive-channel') return toggleChannel(id, false);
  if (action === 'restore-channel') return toggleChannel(id, true);
  if (action === 'unlist-listing') return unlistListingAction(id);
  if (action === 'export-tax-csv') return exportTaxCsvSet();
  if (action === 'export-tax-html') return exportTaxHelperHtml();
  if (action === 'mark-inventory-checked') return markInventoryChecked();
}

function toggleChannel(id, active) {
  patchDataset(d => active ? restoreSalesChannel(d, id) : archiveSalesChannel(d, id));
  toast(active ? '出品先を再開しました' : '出品先を停止しました');
  render();
}

function unlistListingAction(id) {
  patchDataset(d => unlistListing(d, id));
  toast('出品を取り下げました');
  render();
}

function jumpTo(type, id) {
  if (type === 'material') { state.view = 'register'; render(); toast('材料一覧を表示しました'); }
  else if (type === 'inventory' || type === 'listing') { state.view = 'inventory'; render(); toast('在庫一覧を表示しました'); }
  else if (type === 'sale') { state.view = 'sales'; render(); toast('販売履歴を表示しました'); }
  else if (type === 'expense') { openExpenseModal(id); }
  else { state.view = 'analysis'; render(); }
}

function saveStatus(id) {
  const select = document.querySelector(`[data-status-id="${id}"]`);
  const next = select.value;
  patchDataset(d => {
    const inv = d.inventories.find(i => i.id === id);
    if (inv) inv.status = next;
  });
  if (next === 'sold') openSaleModal(id);
  else { toast('ステータスを更新しました'); render(); }
}

function modal(title, body) {
  const div = document.createElement('div');
  div.className = 'modal';
  div.innerHTML = `<div class="modal-card"><div class="row"><h2>${title}</h2><button class="btn ghost" data-close>閉じる</button></div>${body}</div>`;
  document.body.appendChild(div);
  div.addEventListener('click', e => { if (e.target === div || e.target.dataset.close !== undefined) div.remove(); });
  return div;
}

const fv = (form, name) => form.elements[name]?.value ?? '';

function openInventoryModal() {
  const m = modal('在庫追加', `<form class="form" id="inventoryForm">
    <div class="form-grid">
      <label><span>商品名</span><input name="name" required></label>
      <label><span>商品種別</span><select name="productType"><option value="resale">仕入販売品</option><option value="handmade">ハンドメイド</option><option value="hybrid">ハイブリッド</option></select></label>
      <label><span>カテゴリ/ライン</span><input name="productCategory" placeholder="ピアス、布小物など"></label>
      <label><span>ブランド/シリーズ</span><input name="brand"></label>
      <label><span>サイズ</span><input name="size"></label>
      <label><span>原価/仕入れ値</span><input name="costPrice" inputmode="numeric"></label>
      <label><span>想定売価</span><input name="expectedPrice" inputmode="numeric"></label>
      <label><span>仕入日</span><input type="date" name="purchasedAt" value="${todayISO()}"></label>
      <label class="full"><span>メモ</span><textarea name="notes"></textarea></label>
    </div><button class="btn primary" type="submit">保存</button></form>`);
  m.querySelector('form').onsubmit = e => {
    e.preventDefault(); const f = e.currentTarget;
    patchDataset(d => d.inventories.push(createInventory({
      name: fv(f, 'name'), productType: fv(f, 'productType'), productCategory: fv(f, 'productCategory'), brand: fv(f, 'brand'), size: fv(f, 'size'),
      costPrice: num(fv(f, 'costPrice')), expectedPrice: num(fv(f, 'expectedPrice')), purchasedAt: fv(f, 'purchasedAt'), notes: fv(f, 'notes')
    })));
    m.remove(); toast('在庫を追加しました'); state.view = 'inventory'; render();
  };
}

function openSaleModal(invId = '') {
  const d = data();
  const inventoryOpts = d.inventories.map(i => `<option value="${i.id}" ${i.id === invId ? 'selected' : ''}>${escapeHtml(i.name)} / ${productTypeText(i.productType)}</option>`).join('');
  const channelOpts = `<option value="">未設定</option>` + d.salesChannels.filter(c => c.active !== false).map(c => `<option value="${c.id}">${escapeHtml(c.name)} / ${channelTypeText(c.type)}</option>`).join('');
  const listingOpts = `<option value="">指定なし</option>` + d.listingRecords.filter(l => l.status === 'listed' && (!invId || l.inventoryId === invId)).map(l => {
    const inv = d.inventories.find(i => i.id === l.inventoryId);
    const ch = d.salesChannels.find(c => c.id === l.channelId);
    return `<option value="${l.id}" data-inv="${l.inventoryId}">${escapeHtml(inv?.name || '')} / ${escapeHtml(ch?.name || '')} / ${yen(l.listedPrice)}</option>`;
  }).join('');
  const eventOpts = `<option value="">なし</option>` + d.events.map(ev => `<option value="${ev.id}">${escapeHtml(ev.eventName)} / ${ev.eventDate || '-'}</option>`).join('');
  const inv = d.inventories.find(i => i.id === invId);
  const m = modal('販売入力', `<form class="form" id="saleForm">
    <label><span>対象在庫</span><select name="inventoryId">${inventoryOpts}</select></label>
    <div class="form-grid">
      <label><span>出品履歴から選ぶ</span><select name="listingRecordId">${listingOpts}</select></label>
      <label><span>販売場所</span><select name="channelId">${channelOpts}</select></label>
      <label><span>イベント</span><select name="eventId">${eventOpts}</select></label>
      <label><span>販売日</span><input type="date" name="soldAt" value="${todayISO()}"></label>
      <label><span>販売単価</span><input name="grossPrice" inputmode="numeric" value="${inv?.expectedPrice || ''}"></label>
      <label><span>販売手数料</span><input name="fee" inputmode="numeric"></label>
      <label><span>送料</span><input name="shipping" inputmode="numeric"></label>
      <label><span>追加経費</span><input name="extraCost" inputmode="numeric"></label>
      <label class="full"><span>メモ</span><textarea name="memo"></textarea></label>
    </div><button class="btn primary" type="submit">販売を確定</button></form>`);
  const listingSelect = m.querySelector('[name="listingRecordId"]');
  const applyChannelFee = () => {
    const channel = d.salesChannels.find(c => c.id === m.querySelector('[name="channelId"]').value);
    const gross = num(m.querySelector('[name="grossPrice"]').value);
    const feeInput = m.querySelector('[name="fee"]');
    if (channel && gross && !feeInput.value) feeInput.value = Math.round(gross * num(channel.feeRate) / 100);
  };
  listingSelect.onchange = () => {
    const l = d.listingRecords.find(x => x.id === listingSelect.value);
    if (l) {
      m.querySelector('[name="inventoryId"]').value = l.inventoryId;
      m.querySelector('[name="channelId"]').value = l.channelId;
      m.querySelector('[name="grossPrice"]').value = l.listedPrice || '';
      m.querySelector('[name="fee"]').value = '';
      applyChannelFee();
    }
  };
  m.querySelector('[name="channelId"]').onchange = () => { m.querySelector('[name="fee"]').value = ''; applyChannelFee(); };
  m.querySelector('[name="grossPrice"]').oninput = () => { m.querySelector('[name="fee"]').value = ''; applyChannelFee(); };
  m.querySelector('form').onsubmit = e => {
    e.preventDefault(); const f = e.currentTarget;
    patchDataset(d => {
      const inv = d.inventories.find(i => i.id === fv(f, 'inventoryId'));
      const channel = d.salesChannels.find(c => c.id === fv(f, 'channelId'));
      const sale = createSale({
        inventoryId: fv(f, 'inventoryId'), soldAt: fv(f, 'soldAt'), platform: channel?.name || '未設定',
        channelId: fv(f, 'channelId'), listingRecordId: fv(f, 'listingRecordId'), eventId: fv(f, 'eventId'),
        grossPrice: num(fv(f, 'grossPrice')), fee: num(fv(f, 'fee')), shipping: num(fv(f, 'shipping')), extraCost: num(fv(f, 'extraCost')),
        costPrice: num(inv?.costPrice), memo: fv(f, 'memo')
      });
      d.sales.push(sale);
      if (inv) inv.status = 'sold';
      markListingSold(d, sale.listingRecordId, sale.id);
    });
    m.remove(); toast('販売を確定しました'); state.view = 'sales'; render();
  };
}

function openListingModal(invId = '') {
  const d = data();
  if (!d.salesChannels.length) { toast('先に出品先を追加してください'); return openChannelModal(); }
  const invOpts = d.inventories.filter(i => i.status !== 'sold').map(i => `<option value="${i.id}" ${i.id === invId ? 'selected' : ''}>${escapeHtml(i.name)} / ${productTypeText(i.productType)}</option>`).join('');
  const chOpts = d.salesChannels.filter(c => c.active !== false).map(c => `<option value="${c.id}">${escapeHtml(c.name)} / ${channelTypeText(c.type)}</option>`).join('');
  const inv = d.inventories.find(i => i.id === invId);
  const m = modal('出品履歴を追加', `<form class="form" id="listingForm">
    <label><span>商品</span><select name="inventoryId">${invOpts}</select></label>
    <label><span>出品先</span><select name="channelId">${chOpts}</select></label>
    <div class="form-grid">
      <label><span>出品日</span><input type="date" name="listedAt" value="${todayISO()}"></label>
      <label><span>出品価格</span><input name="listedPrice" inputmode="numeric" value="${inv?.expectedPrice || ''}"></label>
      <label class="full"><span>メモ</span><textarea name="memo"></textarea></label>
    </div><button class="btn primary" type="submit">出品を保存</button></form>`);
  m.querySelector('form').onsubmit = e => {
    e.preventDefault(); const f = e.currentTarget;
    patchDataset(d => addListingRecord(d, { inventoryId: fv(f, 'inventoryId'), channelId: fv(f, 'channelId'), listedAt: fv(f, 'listedAt'), listedPrice: num(fv(f, 'listedPrice')), memo: fv(f, 'memo') }));
    m.remove(); toast('出品履歴を保存しました'); state.view = 'inventory'; render();
  };
}

function openChannelModal() {
  const m = modal('出品先追加', `<form class="form" id="channelForm">
    <div class="form-grid">
      <label><span>出品先名</span><input name="name" required placeholder="minne、Creema、委託店舗など"></label>
      <label><span>種類</span><select name="type"><option value="online">ネット</option><option value="store">店舗</option><option value="event">イベント</option><option value="consignment">委託</option><option value="direct">直接販売</option></select></label>
      <label><span>手数料率 %</span><input name="feeRate" inputmode="decimal"></label>
      <label><span>固定費</span><input name="fixedFee" inputmode="numeric"></label>
      <label><span>場所</span><input name="location"></label>
      <label class="full"><span>メモ</span><textarea name="memo"></textarea></label>
    </div><button class="btn primary" type="submit">保存</button></form>`);
  m.querySelector('form').onsubmit = e => {
    e.preventDefault(); const f = e.currentTarget;
    patchDataset(d => addSalesChannel(d, { name: fv(f, 'name'), type: fv(f, 'type'), feeRate: num(fv(f, 'feeRate')), fixedFee: num(fv(f, 'fixedFee')), location: fv(f, 'location'), memo: fv(f, 'memo') }));
    m.remove(); toast('出品先を追加しました'); state.view = 'register'; render();
  };
}

function openEventModal() {
  const d = data();
  const chOpts = `<option value="">イベント名から新規作成</option>` + d.salesChannels.filter(c => c.type === 'event').map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const m = modal('イベント追加', `<form class="form" id="eventForm">
    <div class="form-grid">
      <label><span>イベント名</span><input name="eventName" required></label>
      <label><span>既存イベント出品先</span><select name="channelId">${chOpts}</select></label>
      <label><span>開催日</span><input type="date" name="eventDate" value="${todayISO()}"></label>
      <label><span>場所</span><input name="location"></label>
      <label><span>出店料</span><input name="boothFee" inputmode="numeric"></label>
      <label><span>交通費</span><input name="transportCost" inputmode="numeric"></label>
      <label><span>その他費用</span><input name="otherCost" inputmode="numeric"></label>
      <label class="full"><span>メモ</span><textarea name="memo"></textarea></label>
    </div><button class="btn primary" type="submit">保存</button></form>`);
  m.querySelector('form').onsubmit = e => {
    e.preventDefault(); const f = e.currentTarget;
    patchDataset(d => addEventRecord(d, { channelId: fv(f, 'channelId'), eventName: fv(f, 'eventName'), eventDate: fv(f, 'eventDate'), location: fv(f, 'location'), boothFee: num(fv(f, 'boothFee')), transportCost: num(fv(f, 'transportCost')), otherCost: num(fv(f, 'otherCost')), memo: fv(f, 'memo') }));
    m.remove(); toast('イベントを追加しました'); state.view = 'register'; render();
  };
}

function openExpenseModal() {
  const m = modal('経費追加', `<form class="form" id="expenseForm"><div class="form-grid">
    <label><span>日付</span><input type="date" name="date" value="${todayISO()}"></label>
    <label><span>分類</span><select name="category"><option>未分類</option><option>販売手数料</option><option>送料</option><option>梱包資材</option><option>材料購入</option><option>外注加工</option><option>備品</option><option>その他</option></select></label>
    <label><span>金額</span><input name="amount" inputmode="numeric"></label>
    <label><span>支払先</span><input name="vendor"></label>
    <label class="full"><span>メモ</span><textarea name="memo"></textarea></label></div><button class="btn primary" type="submit">保存</button></form>`);
  m.querySelector('form').onsubmit = e => {
    e.preventDefault(); const f = e.currentTarget;
    patchDataset(d => d.expenses.push(createExpense({ date: fv(f, 'date'), category: fv(f, 'category'), amount: num(fv(f, 'amount')), vendor: fv(f, 'vendor'), memo: fv(f, 'memo') })));
    m.remove(); toast('経費を保存しました'); render();
  };
}

function openMaterialModal() {
  const m = modal('材料追加', `<form class="form" id="materialForm"><div class="form-grid"><label><span>材料名</span><input name="name" required></label><label><span>カテゴリ</span><input name="category" value="材料"></label><label><span>単位</span><input name="unit" value="個"></label><label><span>要補充ライン</span><input name="reorderPoint" inputmode="numeric"></label><label class="full"><span>メモ</span><textarea name="memo"></textarea></label></div><button class="btn primary" type="submit">保存</button></form>`);
  m.querySelector('form').onsubmit = e => { e.preventDefault(); const f = e.currentTarget; patchDataset(d => d.materials.push(createMaterial({ name: fv(f, 'name'), category: fv(f, 'category'), unit: fv(f, 'unit'), reorderPoint: num(fv(f, 'reorderPoint')), memo: fv(f, 'memo') }))); m.remove(); toast('材料を保存しました'); state.view = 'register'; render(); };
}

function openMaterialPurchaseModal() {
  const opts = data().materials.map(m => `<option value="${m.id}">${escapeHtml(m.name)} / ${escapeHtml(m.unit)}</option>`).join('');
  const m = modal('材料購入', `<form class="form" id="mpForm"><label><span>材料</span><select name="materialId">${opts}</select></label><div class="form-grid"><label><span>購入日</span><input type="date" name="date" value="${todayISO()}"></label><label><span>数量</span><input name="qty" inputmode="decimal"></label><label><span>金額</span><input name="amount" inputmode="numeric"></label><label><span>購入先</span><input name="vendor"></label><label class="full"><span>メモ</span><textarea name="memo"></textarea></label></div><button class="btn primary" type="submit">保存</button></form>`);
  m.querySelector('form').onsubmit = e => { e.preventDefault(); const f = e.currentTarget; patchDataset(d => d.materialPurchases.push(createMaterialPurchase({ materialId: fv(f, 'materialId'), date: fv(f, 'date'), qty: num(fv(f, 'qty')), amount: num(fv(f, 'amount')), vendor: fv(f, 'vendor'), memo: fv(f, 'memo') }))); m.remove(); toast('材料購入を保存しました'); state.view = 'register'; render(); };
}

function openRecipeModal() {
  const materials = data().materials;
  const compRows = materials.map(m => `<label><span>${escapeHtml(m.name)} 使用量</span><input name="mat_${m.id}" inputmode="decimal" placeholder="0"></label>`).join('');
  const m = modal('レシピ/BOM登録', `<form class="form" id="recipeForm"><div class="form-grid"><label><span>完成品名</span><input name="name" required></label><label><span>カテゴリ</span><input name="category" value="ハンドメイド"></label><label><span>作業目安（分）</span><input name="defaultLaborMinutes" inputmode="numeric"></label></div><h3>材料使用量</h3><div class="form-grid">${compRows || '<div class="muted">先に材料を登録してください。</div>'}</div><label><span>メモ</span><textarea name="memo"></textarea></label><button class="btn primary" type="submit">保存</button></form>`);
  m.querySelector('form').onsubmit = e => { e.preventDefault(); const f = e.currentTarget; const comps = materials.map(mat => ({ materialId: mat.id, qty: num(fv(f, `mat_${mat.id}`)) })).filter(c => c.qty > 0); patchDataset(d => d.recipes.push(createRecipe({ name: fv(f, 'name'), category: fv(f, 'category'), defaultLaborMinutes: num(fv(f, 'defaultLaborMinutes')), components: comps, memo: fv(f, 'memo') }))); m.remove(); toast('レシピを保存しました'); render(); };
}

function openBatchModal() {
  const opts = data().recipes.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  const m = modal('制作ロット作成', `<form class="form" id="batchForm"><label><span>レシピ</span><select name="recipeId">${opts}</select></label><div class="form-grid"><label><span>制作日</span><input type="date" name="date" value="${todayISO()}"></label><label><span>完成数量</span><input name="outputQty" value="1" inputmode="numeric"></label><label><span>追加直接費</span><input name="directCost" inputmode="numeric"></label><label><span>想定売価</span><input name="expectedPrice" inputmode="numeric"></label><label><span>不良数</span><input name="badQty" inputmode="numeric"></label><label class="full"><span>メモ</span><textarea name="memo"></textarea></label></div><button class="btn primary" type="submit">制作を確定</button></form>`);
  m.querySelector('form').onsubmit = e => { e.preventDefault(); const f = e.currentTarget; try { patchDataset(d => createBatchAndInventories(d, { recipeId: fv(f, 'recipeId'), date: fv(f, 'date'), outputQty: num(fv(f, 'outputQty')), directCost: num(fv(f, 'directCost')), expectedPrice: num(fv(f, 'expectedPrice')), badQty: num(fv(f, 'badQty')), memo: fv(f, 'memo') })); m.remove(); toast('制作ロットを確定しました'); state.view = 'inventory'; render(); } catch (err) { toast(err.message); } };
}

function openSettingsModal() {
  const d = data(), v = validateDataset(d);
  const m = modal('設定 / バックアップ', `<div class="grid">
    <div class="section-actions">
      <button class="btn primary" data-set="export">JSONバックアップ</button>
      <button class="btn ghost" data-set="csv">帳簿CSV</button>
      <button class="btn danger" data-set="reset">初期化</button>
    </div>
    <div class="panel">
      <b>JSON Import</b>
      <div class="muted" style="margin:6px 0 10px">iPhone Safari対策として、ファイル選択欄を隠さず表示します。</div>
      <input type="file" accept=".json,.txt,application/json,text/plain" data-set="import-file">
      <div class="muted" style="margin:12px 0 8px">ファイル選択で動かない場合は、JSON本文を貼り付けてImportできます。</div>
      <textarea data-set="import-paste" placeholder="ここにJSONを貼り付け"></textarea>
      <button class="btn blue" data-set="import-paste-run" style="margin-top:10px">貼り付けJSONをImport</button>
    </div>
    <div class="panel"><b>データ検査</b><div class="muted">警告 ${v.warnings.length}件 / エラー ${v.errors.length}件</div></div>
  </div>`);
  m.querySelector('[data-set="export"]').onclick = () => downloadText(`noirstock_backup_v6_5_0_1_${Date.now()}.json`, JSON.stringify(data(), null, 2));
  m.querySelector('[data-set="csv"]').onclick = () => exportLedgerCSV();
  m.querySelector('[data-set="reset"]').onclick = () => { if (confirm('全データを初期化しますか？')) { createAutoBackup('before-reset'); resetDataset(); m.remove(); render(); } };

  async function runImportText(text) {
    const clean = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!clean) { toast('ImportするJSONが空です'); return; }
    const parsed = JSON.parse(clean);
    const n = normalizeToV64(parsed);
    const r = validateDataset(n);
    const ok = confirm(`Importプレビュー\n在庫 ${n.inventories.length}件\n販売 ${n.sales.length}件\n経費 ${n.expenses.length}件\n材料 ${n.materials.length}件\n出品先 ${n.salesChannels.length}件\n出品履歴 ${n.listingRecords.length}件\nイベント ${n.events.length}件\n警告 ${r.warnings.length}件\n\n取り込みますか？`);
    if (ok) {
      createAutoBackup('before-import');
      replaceDataset(n);
      m.remove();
      toast('Importしました');
      render();
    }
  }

  m.querySelector('[data-set="import-file"]').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await runImportText(await readFileAsText(file));
    } catch (err) {
      console.error(err);
      toast(`Import失敗: ${err.message}`);
    }
  };

  m.querySelector('[data-set="import-paste-run"]').onclick = async () => {
    try {
      await runImportText(m.querySelector('[data-set="import-paste"]').value);
    } catch (err) {
      console.error(err);
      toast(`Import失敗: ${err.message}`);
    }
  };
}

function exportLedgerCSV() {
  const d = data(), by = Object.fromEntries(d.inventories.map(i => [i.id, i])), ch = Object.fromEntries(d.salesChannels.map(c => [c.id, c.name]));
  const rows = d.sales.map(s => { const inv = by[s.inventoryId], c = saleProfit(s, inv); return { 販売日: s.soldAt, 商品名: inv?.name || '', 商品種別: productTypeText(inv?.productType), 販売場所: ch[s.channelId] || s.platform || '', 売上: c.gross, 原価: c.cost, 手数料: c.fee, 送料: c.shipping, 実利益: c.profit, 利益率: c.margin.toFixed(1) }; });
  downloadText(`noirstock_ledger_${Date.now()}.csv`, '\ufeff' + makeCSV(['販売日', '商品名', '商品種別', '販売場所', '売上', '原価', '手数料', '送料', '実利益', '利益率'], rows), 'text/csv');
}

function markInventoryChecked() {
  patchDataset(d => { d.taxSettings.inventoryCheckedYears ||= []; if (!d.taxSettings.inventoryCheckedYears.includes(String(state.year))) d.taxSettings.inventoryCheckedYears.push(String(state.year)); });
  toast('棚卸確認済みにしました'); render();
}

render();
