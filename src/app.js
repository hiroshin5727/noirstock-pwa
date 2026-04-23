import { getAll, put, remove, exportAll, bulkReplace } from './db.js';
import {
  yen, pct, uid, safeNum, todayDate, nowLocalDateTime,
  monthKeyFromDateString, yearFromDateString, downloadBlob,
  toCSV, parseMercariText, escapeHtml, fileToDataUrl
} from './utils.js';

const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];

const VIEW_IDS = ['home', 'inventory', 'register', 'sale', 'analytics'];
const STATUS_FILTERS = ['all', '在庫中', '出品中', '要確認', '販売済'];
const CURRENT_YEAR = new Date().getFullYear();

const state = {
  inventory: [],
  sales: [],
  expenses: [],
  currentView: 'home',
  deferredPrompt: null,
  inventoryFilter: 'all',
  inventorySort: 'updated',
  inventorySearch: '',
  saleSearch: '',
  expenseSearch: '',
  analyticsPeriod: 'month',
  analyticsYear: CURRENT_YEAR,
  pendingInventoryPhoto: null,
  pendingSaleProof: null,
  saleParseResult: {},
  migrationData: null,
};

function toast(message) {
  const el = qs('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function openModal(id) { qs(`#${id}`)?.classList.remove('hidden'); }
function closeModal(id) { qs(`#${id}`)?.classList.add('hidden'); }

function openConfirm({ title, message, okText = '実行', onOk }) {
  qs('#confirmTitle').textContent = title;
  qs('#confirmMessage').textContent = message;
  qs('#confirmOk').textContent = okText;
  openModal('confirmModal');
  qs('#confirmCancel').onclick = () => closeModal('confirmModal');
  qs('#confirmOk').onclick = async () => {
    closeModal('confirmModal');
    if (onOk) await onOk();
  };
}

function switchView(view) {
  state.currentView = view;
  VIEW_IDS.forEach((name) => {
    qs(`#${name}View`)?.classList.toggle('active', name === view);
    qsa(`.tab[data-nav="${name}"]`).forEach((el) => el.classList.toggle('active', name === view));
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function inventoryById(id) { return state.inventory.find((item) => item.id === id) || null; }
function saleById(id) { return state.sales.find((sale) => sale.id === id) || null; }
function expenseById(id) { return state.expenses.find((expense) => expense.id === id) || null; }

function soldQtyForInventory(inventoryId, excludeSaleId = '') {
  return state.sales
    .filter((sale) => sale.inventoryId === inventoryId && sale.id !== excludeSaleId)
    .reduce((sum, sale) => sum + Math.max(1, safeNum(sale.saleQty || 1)), 0);
}

function remainingQty(item, excludeSaleId = '') {
  return Math.max(0, safeNum(item?.quantity || 1) - soldQtyForInventory(item?.id, excludeSaleId));
}

function calcSaleDerived(sale, inventoryItem) {
  const saleQty = Math.max(1, safeNum(sale.saleQty || 1));
  const salePrice = safeNum(sale.salePrice);
  const platformFee = safeNum(sale.platformFee);
  const shippingFee = safeNum(sale.shippingFee);
  const itemExpense = safeNum(sale.itemExpense);
  const purchaseUnit = safeNum(inventoryItem?.purchasePrice);
  const grossSales = salePrice * saleQty;
  const netAmount = sale.netAmount !== '' && sale.netAmount !== null && sale.netAmount !== undefined
    ? safeNum(sale.netAmount)
    : Math.max(0, grossSales - platformFee - shippingFee);
  const cogs = purchaseUnit * saleQty;
  const grossProfit = netAmount - cogs;
  const realProfit = grossProfit - itemExpense;
  const margin = grossSales > 0 ? realProfit / grossSales : 0;
  return { saleQty, salePrice, grossSales, platformFee, shippingFee, itemExpense, netAmount, cogs, grossProfit, realProfit, margin };
}

function reviewItems() {
  const issues = [];
  state.inventory.forEach((item) => {
    const missing = [];
    if (!item.name) missing.push('商品名');
    if (!safeNum(item.purchasePrice)) missing.push('仕入れ値');
    if (!item.purchaseDate) missing.push('仕入日');
    if (!item.category) missing.push('カテゴリー');
    if (!item.status) missing.push('ステータス');
    if (['在庫中', '出品中'].includes(item.status) && remainingQty(item) <= 0) missing.push('在庫残数要確認');
    if (missing.length) issues.push({ type: 'inventory', id: item.id, title: item.name || '無題在庫', detail: missing.join(' / ') });
  });
  state.sales.forEach((sale) => {
    const inv = inventoryById(sale.inventoryId);
    const missing = [];
    if (!inv) missing.push('在庫紐づけなし');
    if (!sale.saleDate) missing.push('販売日');
    if (!safeNum(sale.salePrice)) missing.push('販売単価');
    if (!sale.platform) missing.push('販売先');
    if (missing.length) issues.push({ type: 'sale', id: sale.id, title: inv?.name || '販売データ', detail: missing.join(' / ') });
  });
  const dedupe = new Map();
  state.inventory.forEach((item) => {
    if (!item.name) return;
    const key = `${(item.name || '').trim().toLowerCase()}|${(item.brand || '').trim().toLowerCase()}|${item.purchaseDate || ''}`;
    if (!dedupe.has(key)) dedupe.set(key, []);
    dedupe.get(key).push(item);
  });
  [...dedupe.values()].filter((rows) => rows.length > 1).forEach((rows) => {
    issues.push({
      type: 'inventory',
      id: rows[0].id,
      title: rows[0].name || '重複候補',
      detail: `重複候補 ${rows.length}件 / ${rows.map((row) => row.brand || '-').join(', ')}`
    });
  });
  return issues;
}

function inventoryStatusMeta(status) {
  if (status === '販売済') return { cls: 'status-sold', label: '販売済' };
  if (status === '出品中') return { cls: 'status-listed', label: '出品中' };
  if (status === '保留') return { cls: 'status-hold', label: '保留' };
  if (status === '要確認') return { cls: 'status-review', label: '要確認' };
  return { cls: 'status-stock', label: '在庫中' };
}

function getYears() {
  const years = new Set([CURRENT_YEAR]);
  state.inventory.forEach((item) => {
    const y = yearFromDateString(item.purchaseDate);
    if (y) years.add(Number(y));
    if (item.carryOverYear) years.add(Number(item.carryOverYear));
  });
  state.sales.forEach((sale) => { const y = yearFromDateString(sale.saleDate); if (y) years.add(Number(y)); });
  state.expenses.forEach((expense) => { const y = yearFromDateString(expense.date); if (y) years.add(Number(y)); });
  return [...years].sort((a, b) => b - a);
}

function startOfDay(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0); return d;
}
function endOfDay(date) {
  const d = new Date(date); d.setHours(23, 59, 59, 999); return d;
}
function formatLabelMonth(date) { return `${date.getMonth() + 1}/${date.getDate()}`; }
function formatLabelYearMonth(date) { return `${String(date.getFullYear()).slice(-2)}/${date.getMonth() + 1}`; }

function getPeriodBounds(period, year = state.analyticsYear) {
  const now = new Date();
  const y = Number(year) || CURRENT_YEAR;
  if (period === 'all') return { start: null, end: null, label: '全期間' };
  if (period === 'year') return { start: new Date(y, 0, 1), end: endOfDay(new Date(y, 11, 31)), label: `${y}年` };
  if (period === 'quarter') {
    const base = now.getFullYear() === y ? now : new Date(y, 11, 31);
    const end = endOfDay(base);
    const start = new Date(base.getFullYear(), base.getMonth() - 2, 1);
    return { start, end, label: `${start.getMonth() + 1}〜${end.getMonth() + 1}月` };
  }
  const base = now.getFullYear() === y ? now : new Date(y, 11, 31);
  const start = new Date(base.getFullYear(), base.getMonth(), 1);
  const end = endOfDay(base);
  return { start, end, label: `${base.getMonth() + 1}月` };
}

function inRange(dateString, start, end) {
  if (!dateString) return false;
  const t = new Date(dateString);
  if (Number.isNaN(t.getTime())) return false;
  if (start && t < start) return false;
  if (end && t > end) return false;
  return true;
}

function aggregateForRange(start, end) {
  const sales = state.sales.filter((sale) => inRange(sale.saleDate, start, end));
  const expenses = state.expenses.filter((expense) => inRange(expense.date, start, end));

  let grossSales = 0;
  let netReceipts = 0;
  let fees = 0;
  let shipping = 0;
  let cogs = 0;
  let itemExpenses = 0;
  let commonExpenses = 0;
  const productProfit = [];
  const platformMap = new Map();

  sales.forEach((sale) => {
    const inv = inventoryById(sale.inventoryId);
    const derived = calcSaleDerived(sale, inv);
    grossSales += derived.grossSales;
    netReceipts += derived.netAmount;
    fees += derived.platformFee;
    shipping += derived.shippingFee;
    cogs += derived.cogs;
    itemExpenses += derived.itemExpense;
    const realProfit = derived.realProfit;
    const key = sale.platform || 'その他';
    productProfit.push({
      saleId: sale.id,
      inventoryId: sale.inventoryId,
      name: inv?.name || '不明商品',
      brand: inv?.brand || '',
      sku: inv?.lotName || inv?.id || '',
      platform: key,
      date: sale.saleDate,
      image: inv?.photoDataUrl || '',
      realProfit,
      margin: derived.margin,
    });
    platformMap.set(key, (platformMap.get(key) || 0) + realProfit);
  });

  commonExpenses = expenses.reduce((sum, item) => sum + safeNum(item.amount), 0);
  const realProfit = netReceipts - cogs - itemExpenses - commonExpenses;
  const margin = grossSales > 0 ? realProfit / grossSales : 0;

  return {
    grossSales,
    netReceipts,
    fees,
    shipping,
    cogs,
    itemExpenses,
    commonExpenses,
    realProfit,
    margin,
    saleCount: sales.length,
    expenseCount: expenses.length,
    productProfit,
    platformMap: [...platformMap.entries()].sort((a, b) => b[1] - a[1]),
    sales,
    expenses,
  };
}

function buildTrendSeries(period, year) {
  const { start, end } = getPeriodBounds(period, year);
  if (period === 'month') {
    const startDate = startOfDay(start || new Date());
    const endDate = endOfDay(end || new Date());
    const rows = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const label = formatLabelMonth(d);
      const agg = aggregateForRange(startOfDay(d), endOfDay(d));
      rows.push({ label, sales: agg.grossSales, net: agg.realProfit, margin: agg.margin });
    }
    return rows;
  }
  const rows = [];
  let baseStart = start || new Date(Math.min(...state.sales.map((sale) => new Date(sale.saleDate).getTime()).filter(Boolean)) || Date.now());
  let baseEnd = end || new Date(Math.max(...state.sales.map((sale) => new Date(sale.saleDate).getTime()).filter(Boolean)) || Date.now());
  if (period === 'quarter') {
    let current = new Date(baseStart.getFullYear(), baseStart.getMonth(), 1);
    const last = new Date(baseEnd.getFullYear(), baseEnd.getMonth(), 1);
    while (current <= last) {
      const monthStart = new Date(current.getFullYear(), current.getMonth(), 1);
      const monthEnd = endOfDay(new Date(current.getFullYear(), current.getMonth() + 1, 0));
      const agg = aggregateForRange(monthStart, monthEnd);
      rows.push({ label: formatLabelYearMonth(current), sales: agg.grossSales, net: agg.realProfit, margin: agg.margin });
      current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    }
    return rows;
  }
  if (period === 'year') {
    for (let month = 0; month < 12; month += 1) {
      const monthStart = new Date(Number(year), month, 1);
      const monthEnd = endOfDay(new Date(Number(year), month + 1, 0));
      const agg = aggregateForRange(monthStart, monthEnd);
      rows.push({ label: `${month + 1}月`, sales: agg.grossSales, net: agg.realProfit, margin: agg.margin });
    }
    return rows;
  }
  let current = new Date(baseStart.getFullYear(), baseStart.getMonth(), 1);
  const last = new Date(baseEnd.getFullYear(), baseEnd.getMonth(), 1);
  while (current <= last) {
    const monthStart = new Date(current.getFullYear(), current.getMonth(), 1);
    const monthEnd = endOfDay(new Date(current.getFullYear(), current.getMonth() + 1, 0));
    const agg = aggregateForRange(monthStart, monthEnd);
    rows.push({ label: formatLabelYearMonth(current), sales: agg.grossSales, net: agg.realProfit, margin: agg.margin });
    current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  }
  return rows.slice(-12);
}

function drawMiniLine(containerSelector, values, stroke = '#67db86') {
  const el = qs(containerSelector);
  if (!el) return;
  const series = values.length ? values : [0, 0, 0, 0];
  const width = 220; const height = 56; const pad = 4;
  const max = Math.max(1, ...series.map((v) => Math.abs(v)));
  const step = series.length > 1 ? (width - pad * 2) / (series.length - 1) : width - pad * 2;
  const points = series.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - (Math.abs(v) / max) * (height - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline fill="none" stroke="${stroke}" stroke-width="3" points="${points}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function drawMiniBars(containerSelector, values) {
  const el = qs(containerSelector);
  if (!el) return;
  const series = values.length ? values : [0, 0, 0, 0];
  const max = Math.max(1, ...series.map((v) => Math.abs(v)));
  el.innerHTML = series.map((v) => `<span style="height:${Math.max(10, Math.round((Math.abs(v) / max) * 52))}px"></span>`).join('');
}

function drawTrendChart(containerSelector, rows) {
  const el = qs(containerSelector);
  if (!el) return;
  const width = 780; const height = 300; const padX = 50; const padY = 28;
  const labels = rows.map((row) => row.label);
  const salesValues = rows.map((row) => row.sales);
  const netValues = rows.map((row) => row.net);
  const max = Math.max(1, ...salesValues, ...netValues);
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;
  const step = rows.length > 1 ? plotW / (rows.length - 1) : plotW;
  const toPoints = (values) => values.map((value, idx) => {
    const x = padX + idx * step;
    const y = height - padY - (Math.max(0, value) / max) * plotH;
    return [x, y];
  });
  const salesPoints = toPoints(salesValues);
  const netPoints = toPoints(netValues);
  const gridVals = [0, 0.25, 0.5, 0.75, 1];
  const lines = gridVals.map((p) => {
    const y = height - padY - p * plotH;
    const label = Math.round(max * p).toLocaleString('ja-JP');
    return `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4 4"/><text x="${padX - 10}" y="${y + 4}" fill="rgba(255,255,255,0.55)" font-size="12" text-anchor="end">${label}</text>`;
  }).join('');
  const xLabels = labels.map((label, idx) => `<text x="${padX + idx * step}" y="${height - 6}" fill="rgba(255,255,255,0.55)" font-size="12" text-anchor="middle">${escapeHtml(label)}</text>`).join('');
  const poly = (pts, color) => `<polyline fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}"/>`;
  const dots = (pts, color) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`).join('');
  el.innerHTML = `<div class="chart-surface"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${lines}${poly(salesPoints, '#67db86')}${poly(netPoints, '#9be5b4')}${dots(salesPoints, '#67db86')}${dots(netPoints, '#9be5b4')}${xLabels}</svg></div>`;
}

function renderSummaryYearOptions() {
  const select = qs('#summaryYearSelect');
  const years = getYears();
  if (!years.includes(state.analyticsYear)) state.analyticsYear = years[0] || CURRENT_YEAR;
  select.innerHTML = years.map((year) => `<option value="${year}" ${Number(year) === Number(state.analyticsYear) ? 'selected' : ''}>${year}年</option>`).join('');
}

function renderHome() {
  const today = todayDate();
  const todaySales = state.sales.filter((sale) => (sale.saleDate || '').startsWith(today));
  const todayAgg = aggregateForRange(startOfDay(new Date(today)), endOfDay(new Date(today)));
  const monthBounds = getPeriodBounds('month', state.analyticsYear);
  const monthAgg = aggregateForRange(monthBounds.start, monthBounds.end);
  const prevMonthDate = new Date(monthBounds.start);
  prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
  const prevMonthStart = new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth(), 1);
  const prevMonthEnd = endOfDay(new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth() + 1, 0));
  const prevMonthAgg = aggregateForRange(prevMonthStart, prevMonthEnd);
  const marginDiff = monthAgg.margin - prevMonthAgg.margin;

  qs('#homeTodaySales').textContent = yen(todayAgg.grossSales);
  qs('#homeTodaySalesCount').textContent = `${todaySales.length}件`;
  qs('#homeMonthProfit').textContent = yen(monthAgg.realProfit);
  qs('#homeMonthProfitSub').textContent = `利益率 ${pct(monthAgg.margin)}`;
  qs('#homeMonthMargin').textContent = pct(monthAgg.margin);
  qs('#homeMonthMarginSub').textContent = `前月比 ${marginDiff >= 0 ? '+' : ''}${(marginDiff * 100).toFixed(1)}pt`;

  const monthRows = buildTrendSeries('month', state.analyticsYear);
  drawMiniLine('#homeChartSales', monthRows.map((row) => row.sales));
  drawMiniBars('#homeChartProfit', monthRows.map((row) => row.net));
  drawMiniLine('#homeChartMargin', monthRows.map((row) => row.margin * 100));

  const issues = reviewItems();
  const attentionRows = [
    { label: '仕入れ値未入力', count: state.inventory.filter((item) => !safeNum(item.purchasePrice)).length, cls: 'warn' },
    { label: 'OCR未確定', count: state.sales.filter((sale) => sale.proofImageDataUrl && !sale.externalItemId).length, cls: 'danger' },
    { label: '要確認全体', count: issues.length, cls: issues.length ? 'warn' : 'warn' },
  ].filter((row, idx) => idx < 2 || issues.length);
  qs('#homeAttentionList').innerHTML = attentionRows.length
    ? attentionRows.map((row) => `
      <div class="attention-row">
        <div class="left"><div class="attention-icon ${row.cls}">${row.cls === 'danger' ? '!' : '!'}</div><div><strong>${row.label}</strong></div></div>
        <div class="attention-count">${row.count}件</div>
      </div>`).join('')
    : '<div class="muted">要確認はありません。</div>';

  const activities = [
    ...state.sales.map((sale) => {
      const inv = inventoryById(sale.inventoryId);
      return { type: 'sale', title: '販売を登録しました', detail: inv?.name || '不明商品', time: sale.saleDate || sale.createdAt || '', sort: new Date(sale.saleDate || sale.createdAt || 0).getTime() };
    }),
    ...state.inventory.map((item) => ({ type: 'inventory', title: '在庫を追加しました', detail: item.name || '無題商品', time: item.createdAt || item.purchaseDate || '', sort: new Date(item.createdAt || item.purchaseDate || 0).getTime() })),
    ...state.expenses.map((expense) => ({ type: 'expense', title: '経費を登録しました', detail: expense.title || expense.category || '経費', time: expense.date || expense.createdAt || '', sort: new Date(expense.date || expense.createdAt || 0).getTime() })),
  ].sort((a, b) => b.sort - a.sort).slice(0, 5);

  const iconMap = { sale: ['sale', '🛒'], inventory: ['inventory', '◫'], expense: ['ocr', '¥'] };
  qs('#homeRecentActivity').innerHTML = activities.length
    ? activities.map((row) => {
      const [cls, icon] = iconMap[row.type] || ['review', '•'];
      return `
        <div class="activity-row">
          <div class="activity-icon ${cls}">${icon}</div>
          <div class="activity-main"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.detail)}</span></div>
          <div class="activity-time">${row.time ? new Date(row.time).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '-'}</div>
        </div>`;
    }).join('')
    : '<div class="muted">最近の活動はまだありません。</div>';
}

function renderInventory() {
  const search = (state.inventorySearch || '').trim().toLowerCase();
  const reviewIds = new Set(reviewItems().filter((row) => row.type === 'inventory').map((row) => row.id));
  const counts = {
    all: state.inventory.length,
    '在庫中': state.inventory.filter((item) => item.status === '在庫中').length,
    '出品中': state.inventory.filter((item) => item.status === '出品中').length,
    '販売済': state.inventory.filter((item) => item.status === '販売済').length,
    '要確認': reviewIds.size,
  };
  qs('#inventoryStatusChips').innerHTML = STATUS_FILTERS.map((filter) => {
    const key = filter;
    const count = filter === 'all' ? counts.all : counts[filter] || 0;
    const label = filter === 'all' ? 'すべて' : filter;
    return `<button class="filter-chip ${state.inventoryFilter === filter ? 'active' : ''}" data-filter="${filter}">${label}<strong>${count}</strong></button>`;
  }).join('');

  let rows = state.inventory.filter((item) => {
    if (search) {
      const hay = `${item.name || ''} ${item.brand || ''} ${item.category || ''} ${item.lotName || ''} ${item.id || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (state.inventoryFilter === '要確認') return reviewIds.has(item.id);
    if (state.inventoryFilter !== 'all') return item.status === state.inventoryFilter;
    return true;
  });

  rows = rows.sort((a, b) => {
    if (state.inventorySort === 'profit') return (safeNum(b.plannedPrice) - safeNum(b.purchasePrice)) - (safeNum(a.plannedPrice) - safeNum(a.purchasePrice));
    if (state.inventorySort === 'purchase') return safeNum(b.purchasePrice) - safeNum(a.purchasePrice);
    return new Date(b.createdAt || b.purchaseDate || 0) - new Date(a.createdAt || a.purchaseDate || 0);
  });

  qs('#inventoryCountLabel').textContent = `${rows.length}件`;
  qs('#inventoryList').innerHTML = rows.length ? rows.map((item) => {
    const remain = remainingQty(item);
    const planned = safeNum(item.plannedPrice);
    const estProfit = planned - safeNum(item.purchasePrice);
    const status = item.status === '販売済' ? '販売済' : (reviewIds.has(item.id) ? '要確認' : (item.status || '在庫中'));
    const statusMeta = inventoryStatusMeta(status);
    const canSale = remain > 0 && status !== '販売済';
    return `
      <article class="inventory-card">
        <div class="inventory-top">
          <img class="item-thumb" src="${item.photoDataUrl || 'assets/icon-192.png'}" alt="${escapeHtml(item.name || '商品')}" />
          <div>
            <h3 class="item-title">${escapeHtml(item.name || '無題商品')}</h3>
            <div class="item-meta">
              <span>${escapeHtml(item.brand || 'ブランド未入力')}</span>
              <span>サイズ：${escapeHtml(item.size || '-')} ｜ カラー：${escapeHtml(item.color || '-')}</span>
              <span>SKU: ${escapeHtml(item.lotName || item.id)}</span>
            </div>
          </div>
          <div><span class="status-pill ${statusMeta.cls}">${statusMeta.label}</span></div>
        </div>
        <div class="item-finance">
          <div><span>仕入れ値</span><strong>${yen(item.purchasePrice || 0)}</strong></div>
          <div><span>想定売価</span><strong>${yen(planned)}</strong></div>
          <div><span>見込み利益</span><strong class="profit">${yen(estProfit)} ${planned ? `(${pct(planned > 0 ? estProfit / planned : 0)})` : ''}</strong></div>
        </div>
        <div class="status-editor">
          <div class="flow">
            <strong>ステータス変更</strong>
            <span class="inline-badge">残数 ${remain}</span>
            <select class="inventory-status-select" data-id="${item.id}">
              <option value="在庫中" ${item.status === '在庫中' ? 'selected' : ''}>在庫中</option>
              <option value="出品中" ${item.status === '出品中' ? 'selected' : ''}>出品中</option>
              <option value="販売済" ${item.status === '販売済' ? 'selected' : ''}>販売済</option>
              <option value="保留" ${item.status === '保留' ? 'selected' : ''}>保留</option>
            </select>
            ${canSale ? `<button class="ghost quick-sale" data-id="${item.id}">販売入力</button>` : ''}
          </div>
          <div class="card-actions">
            <button class="ghost edit-inventory" data-id="${item.id}">編集</button>
            <button class="ghost apply-status" data-id="${item.id}">変更する</button>
            <button class="ghost danger-btn delete-inventory" data-id="${item.id}">削除</button>
          </div>
        </div>
      </article>`;
  }).join('') : '<div class="panel empty-state">在庫がまだありません。</div>';

  qsa('.filter-chip').forEach((btn) => btn.onclick = () => { state.inventoryFilter = btn.dataset.filter; renderInventory(); });
  qsa('.edit-inventory').forEach((btn) => btn.onclick = () => { const item = inventoryById(btn.dataset.id); if (item) fillInventoryForm(item); });
  qsa('.quick-sale').forEach((btn) => btn.onclick = () => openSaleForInventory(btn.dataset.id));
  qsa('.apply-status').forEach((btn) => btn.onclick = async () => {
    const item = inventoryById(btn.dataset.id);
    const target = qs(`.inventory-status-select[data-id="${btn.dataset.id}"]`)?.value || item?.status;
    if (!item || !target) return;
    if (target === '販売済') { openSaleForInventory(item.id); return; }
    item.status = target;
    await put('inventory', item);
    await reloadState();
    toast('ステータスを更新しました');
  });
  qsa('.delete-inventory').forEach((btn) => btn.onclick = () => {
    const item = inventoryById(btn.dataset.id);
    if (!item) return;
    openConfirm({ title: '在庫を削除', message: `「${item.name || '商品'}」を削除します。`, okText: '削除', onOk: async () => {
      await remove('inventory', item.id);
      await reloadState();
      toast('在庫を削除しました');
    }});
  });
}

function renderSaleOptions(selectedId = '') {
  const select = qs('#saleInventorySelect');
  const editingSaleId = qs('#saleForm').id.value;
  const options = state.inventory.filter((item) => remainingQty(item, editingSaleId) > 0 || item.id === selectedId);
  select.innerHTML = '<option value="">選択してください</option>' + options.map((item) => {
    const selected = item.id === selectedId ? 'selected' : '';
    return `<option value="${item.id}" ${selected}>${escapeHtml(item.name || '無題商品')} / ${escapeHtml(item.brand || '')} / 残${remainingQty(item, editingSaleId)}</option>`;
  }).join('');
}

function renderSaleProductSummary(inv) {
  const wrap = qs('#saleProductSummary');
  if (!inv) {
    wrap.className = 'sale-product-summary empty-state';
    wrap.innerHTML = '対象商品を選択してください';
    return;
  }
  const statusMeta = inventoryStatusMeta(inv.status || '在庫中');
  wrap.className = 'sale-product-summary';
  wrap.innerHTML = `
    <img class="item-thumb" src="${inv.photoDataUrl || 'assets/icon-192.png'}" alt="${escapeHtml(inv.name || '商品')}" />
    <div>
      <h3>${escapeHtml(inv.name || '')}</h3>
      <span class="status-pill ${statusMeta.cls}">${statusMeta.label}</span>
      <p>仕入れ値（原価） ${yen(inv.purchasePrice || 0)}</p>
    </div>`;
}

function renderSaleCandidates() {
  const wrap = qs('#ocrCandidateWrap');
  const parsed = state.saleParseResult || {};
  const candidateRows = [
    ['externalItemId', '商品ID', parsed.externalItemId],
    ['salePrice', '販売単価', parsed.salePrice ? yen(parsed.salePrice) : ''],
    ['platformFee', '手数料', parsed.platformFee ? yen(parsed.platformFee) : ''],
    ['shippingFee', '送料', parsed.shippingFee ? yen(parsed.shippingFee) : ''],
    ['saleDate', '販売日', parsed.saleDate || ''],
    ['platform', '販売先', parsed.platform || ''],
  ].filter(([, , value]) => value);
  wrap.innerHTML = candidateRows.length ? candidateRows.map(([key, label, value]) => `
    <button type="button" class="candidate-chip apply-candidate" data-key="${key}"><span>${label}</span><strong>${escapeHtml(String(value))}</strong><span class="ok">✓</span></button>
  `).join('') : '<div class="muted">候補はまだありません。テキスト解析を使うか、手入力してください。</div>';
  qsa('.apply-candidate').forEach((btn) => btn.onclick = () => applyCandidate(btn.dataset.key));
}

function applyCandidate(key) {
  const form = qs('#saleForm');
  const parsed = state.saleParseResult || {};
  if (!parsed) return;
  if (key === 'externalItemId') form.externalItemId.value = parsed.externalItemId || '';
  if (key === 'salePrice') form.salePrice.value = safeNum(parsed.salePrice) || '';
  if (key === 'platformFee') form.platformFee.value = safeNum(parsed.platformFee) || '';
  if (key === 'shippingFee') form.shippingFee.value = safeNum(parsed.shippingFee) || '';
  if (key === 'saleDate' && parsed.saleDate) form.saleDate.value = parsed.saleDate;
  if (key === 'platform' && parsed.platform) form.platform.value = parsed.platform;
  renderSaleDetails();
}

function applyAllCandidates() {
  ['externalItemId', 'salePrice', 'platformFee', 'shippingFee', 'saleDate', 'platform'].forEach(applyCandidate);
}

function renderSaleDetails() {
  const form = qs('#saleForm');
  const inv = inventoryById(form.inventoryId.value);
  renderSaleProductSummary(inv);
  renderSaleCandidates();
  const draft = Object.fromEntries(new FormData(form).entries());
  const derived = calcSaleDerived(draft, inv);
  qs('#salePreviewReal').textContent = yen(derived.realProfit);
  qs('#salePreviewMargin').textContent = pct(derived.margin);
  qs('#saleCalcBreakdown').innerHTML = [
    ['売上', yen(derived.grossSales)],
    ['販売手数料', `-${yen(derived.platformFee)}`],
    ['送料', `-${yen(derived.shippingFee)}`],
    ['売上原価', `-${yen(derived.cogs)}`],
    ['商品別追加経費', `-${yen(derived.itemExpense)}`],
    ['実受取額', yen(derived.netAmount)]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function renderSales() {
  renderSaleOptions(qs('#saleForm').inventoryId.value || '');
  const search = (state.saleSearch || '').trim().toLowerCase();
  const rows = [...state.sales].sort((a, b) => new Date(b.saleDate || b.createdAt || 0) - new Date(a.saleDate || a.createdAt || 0)).filter((sale) => {
    if (!search) return true;
    const inv = inventoryById(sale.inventoryId);
    const hay = `${inv?.name || ''} ${sale.platform || ''} ${sale.externalItemId || ''}`.toLowerCase();
    return hay.includes(search);
  });
  qs('#salesList').innerHTML = rows.length ? rows.map((sale) => {
    const inv = inventoryById(sale.inventoryId);
    const derived = calcSaleDerived(sale, inv);
    return `
      <article class="sale-history-card">
        <div class="card-row"><strong>${escapeHtml(inv?.name || '不明商品')}</strong><span class="status-pill status-sold">${escapeHtml(sale.platform || '販売')}</span></div>
        <div class="card-row"><span class="muted">${sale.saleDate ? new Date(sale.saleDate).toLocaleString('ja-JP') : '-'}</span><strong>${yen(derived.grossSales)}</strong></div>
        <div class="card-row"><span class="muted">実利益 ${pct(derived.margin)}</span><strong>${yen(derived.realProfit)}</strong></div>
        <div class="card-actions"><button class="ghost edit-sale" data-id="${sale.id}">編集</button><button class="ghost revert-sale" data-id="${sale.id}">在庫へ戻す</button><button class="ghost danger-btn delete-sale" data-id="${sale.id}">削除</button></div>
      </article>`;
  }).join('') : '<div class="muted">販売履歴はまだありません。</div>';

  qsa('.edit-sale').forEach((btn) => btn.onclick = () => { const sale = saleById(btn.dataset.id); if (sale) fillSaleForm(sale); });
  qsa('.revert-sale').forEach((btn) => btn.onclick = () => {
    const sale = saleById(btn.dataset.id); const inv = inventoryById(sale?.inventoryId);
    if (!sale || !inv) return;
    openConfirm({ title: '販売を取り消す', message: `「${inv.name || '商品'}」を在庫へ戻します。`, okText: '取り消す', onOk: async () => {
      await remove('sales', sale.id);
      inv.status = '在庫中';
      await put('inventory', inv);
      await reloadState();
      toast('在庫へ戻しました');
    }});
  });
  qsa('.delete-sale').forEach((btn) => btn.onclick = () => {
    const sale = saleById(btn.dataset.id);
    if (!sale) return;
    openConfirm({ title: '販売履歴を削除', message: 'この販売履歴を削除します。', okText: '削除', onOk: async () => {
      await remove('sales', sale.id);
      await reloadState();
      toast('販売履歴を削除しました');
    }});
  });
}

function renderExpenseList() {
  const search = (state.expenseSearch || '').trim().toLowerCase();
  const rows = [...state.expenses].sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0)).filter((expense) => {
    if (!search) return true;
    const hay = `${expense.title || ''} ${expense.category || ''} ${expense.memo || ''}`.toLowerCase();
    return hay.includes(search);
  });
  qs('#expenseList').innerHTML = rows.length ? rows.map((expense) => `
    <article class="expense-card">
      <div class="card-row"><strong>${escapeHtml(expense.title || expense.category || '経費')}</strong><span class="status-pill status-review">${escapeHtml(expense.category || '経費')}</span></div>
      <div class="card-row"><span class="muted">${expense.date || '-'}</span><strong>${yen(expense.amount || 0)}</strong></div>
      <div class="card-row"><span class="muted">${escapeHtml(expense.method || '')}</span><span class="muted">${escapeHtml(expense.memo || '')}</span></div>
      <div class="card-actions"><button class="ghost edit-expense" data-id="${expense.id}">編集</button><button class="ghost danger-btn delete-expense" data-id="${expense.id}">削除</button></div>
    </article>
  `).join('') : '<div class="muted">共通経費はまだありません。</div>';
  qsa('.edit-expense').forEach((btn) => btn.onclick = () => { const expense = expenseById(btn.dataset.id); if (expense) fillExpenseForm(expense); });
  qsa('.delete-expense').forEach((btn) => btn.onclick = () => {
    const expense = expenseById(btn.dataset.id);
    if (!expense) return;
    openConfirm({ title: '経費を削除', message: `「${expense.title || expense.category || '経費'}」を削除します。`, okText: '削除', onOk: async () => {
      await remove('expenses', expense.id);
      await reloadState();
      toast('経費を削除しました');
    }});
  });
}

function renderReviewList() {
  const issues = reviewItems();
  qs('#reviewList').innerHTML = issues.length ? issues.map((issue) => `
    <article class="review-card">
      <div class="card-row"><strong>${escapeHtml(issue.title)}</strong><span class="status-pill ${issue.type === 'sale' ? 'status-sold' : 'status-review'}">${issue.type === 'sale' ? '販売' : '在庫'}</span></div>
      <div class="muted">${escapeHtml(issue.detail)}</div>
      <div class="card-actions"><button class="ghost open-review-item" data-type="${issue.type}" data-id="${issue.id}">開く</button></div>
    </article>
  `).join('') : '<div class="muted">要確認はありません。</div>';
  qsa('.open-review-item').forEach((btn) => btn.onclick = () => {
    if (btn.dataset.type === 'sale') {
      const sale = saleById(btn.dataset.id); if (sale) fillSaleForm(sale);
    } else {
      const item = inventoryById(btn.dataset.id); if (item) fillInventoryForm(item);
    }
    closeModal('reviewModal');
  });
}

function renderAnalytics() {
  renderSummaryYearOptions();
  qsa('.period-pill').forEach((btn) => btn.classList.toggle('active', btn.dataset.summaryPeriod === state.analyticsPeriod));
  const bounds = getPeriodBounds(state.analyticsPeriod, state.analyticsYear);
  const agg = aggregateForRange(bounds.start, bounds.end);
  const compareBounds = state.analyticsPeriod === 'month'
    ? (() => {
        const prev = new Date(bounds.start); prev.setMonth(prev.getMonth() - 1);
        return { start: new Date(prev.getFullYear(), prev.getMonth(), 1), end: endOfDay(new Date(prev.getFullYear(), prev.getMonth() + 1, 0)) };
      })()
    : state.analyticsPeriod === 'quarter'
      ? (() => {
          const prev = new Date(bounds.start); prev.setMonth(prev.getMonth() - 3);
          return { start: new Date(prev.getFullYear(), prev.getMonth(), 1), end: endOfDay(new Date(bounds.start.getFullYear(), bounds.start.getMonth(), 0)) };
        })()
      : state.analyticsPeriod === 'year'
        ? { start: new Date(Number(state.analyticsYear) - 1, 0, 1), end: endOfDay(new Date(Number(state.analyticsYear) - 1, 11, 31)) }
        : null;
  const compareAgg = compareBounds ? aggregateForRange(compareBounds.start, compareBounds.end) : null;
  const marginDiff = compareAgg ? agg.margin - compareAgg.margin : 0;

  qs('#sumSales').textContent = yen(agg.grossSales);
  qs('#sumSalesSub').textContent = `${agg.saleCount}件`;
  qs('#sumNet').textContent = yen(agg.realProfit);
  qs('#sumNetSub').textContent = `売上原価 ${yen(agg.cogs)}`;
  qs('#sumMargin').textContent = pct(agg.margin);
  qs('#sumMarginSub').textContent = compareAgg ? `前期比 ${marginDiff >= 0 ? '+' : ''}${(marginDiff * 100).toFixed(1)}pt` : bounds.label;

  const trendRows = buildTrendSeries(state.analyticsPeriod, state.analyticsYear);
  drawMiniLine('#summaryMiniSales', trendRows.map((row) => row.sales));
  drawMiniBars('#summaryMiniNet', trendRows.map((row) => row.net));
  drawMiniLine('#summaryMiniMargin', trendRows.map((row) => row.margin * 100));
  drawTrendChart('#trendChart', trendRows);

  const topRows = [...agg.productProfit].sort((a, b) => b.realProfit - a.realProfit).slice(0, 5);
  qs('#topProfitList').innerHTML = topRows.length ? topRows.map((row, idx) => `
    <article class="sale-history-card">
      <div class="card-row"><strong>${idx + 1}. ${escapeHtml(row.name)}</strong><span class="status-pill status-stock">${escapeHtml(row.platform || '販売')}</span></div>
      <div class="card-row"><span class="muted">${escapeHtml(row.sku || '-') || '-'}</span><strong>${yen(row.realProfit)}</strong></div>
      <div class="card-row"><span class="muted">利益率</span><strong>${pct(row.margin)}</strong></div>
    </article>
  `).join('') : '<div class="muted">対象期間の販売がありません。</div>';

  const colors = ['#67db86', '#4c8dff', '#f1b547', '#a87bff', '#ff6767', '#9aa3b2'];
  const total = Math.max(1, agg.platformMap.reduce((sum, [, value]) => sum + Math.max(0, value), 0));
  const stops = []; let cursor = 0;
  agg.platformMap.forEach(([, value], idx) => {
    const pctVal = Math.max(0, value) / total * 100;
    stops.push(`${colors[idx % colors.length]} ${cursor}% ${cursor + pctVal}%`);
    cursor += pctVal;
  });
  const donut = agg.platformMap.length
    ? `<div class="donut" style="background:conic-gradient(${stops.join(',')})"><div class="donut-center"><div class="muted">実利益合計</div><strong>${yen(agg.realProfit)}</strong></div></div>`
    : '<div class="muted">販売先データがありません。</div>';
  const rows = agg.platformMap.length ? agg.platformMap.map(([platform, value], idx) => `
    <div class="platform-row"><span class="color-dot" style="background:${colors[idx % colors.length]}"></span><span>${escapeHtml(platform)}</span><strong>${yen(value)}</strong><span>${pct(total ? value / total : 0)}</span></div>
  `).join('') : '<div class="muted">販売先データがありません。</div>';
  qs('#summaryBreakdown').innerHTML = `<div class="donut-wrap">${donut}</div><div class="platform-rows">${rows}</div>`;
}

function resetInventoryForm(useDefaults = true) {
  const form = qs('#inventoryForm');
  form.reset();
  form.id.value = '';
  form.createdAt.value = '';
  form.status.value = '在庫中';
  form.quantity.value = 1;
  state.pendingInventoryPhoto = null;
  qs('#inventoryEditingBadge').classList.add('hidden');
  qs('#inventoryPhotoInput').value = '';
  setPreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', null);
  if (useDefaults) switchView('register');
}

function fillInventoryForm(item) {
  const form = qs('#inventoryForm');
  Object.entries(item).forEach(([key, value]) => { if (form[key] && typeof value !== 'object') form[key].value = value ?? ''; });
  state.pendingInventoryPhoto = item.photoDataUrl || null;
  setPreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', state.pendingInventoryPhoto);
  qs('#inventoryEditingBadge').classList.remove('hidden');
  switchView('register');
}

function resetSaleForm(switchToView = false) {
  const form = qs('#saleForm');
  form.reset();
  form.id.value = '';
  form.createdAt.value = '';
  form.saleQty.value = 1;
  form.platform.value = 'メルカリ';
  form.paymentMethod.value = '売上金';
  form.saleDate.value = nowLocalDateTime();
  state.pendingSaleProof = null;
  state.saleParseResult = {};
  qs('#saleEditingBadge').classList.add('hidden');
  qs('#saleParseText').value = '';
  qs('#saleProofInput').value = '';
  setPreview('#saleProofPreview', '#removeSaleProofBtn', null);
  renderSaleOptions();
  renderSaleDetails();
  if (switchToView) switchView('sale');
}

function fillSaleForm(sale) {
  const form = qs('#saleForm');
  Object.entries(sale).forEach(([key, value]) => { if (form[key] && typeof value !== 'object') form[key].value = value ?? ''; });
  qs('#saleEditingBadge').classList.remove('hidden');
  state.pendingSaleProof = sale.proofImageDataUrl || null;
  setPreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
  renderSaleOptions(sale.inventoryId);
  renderSaleDetails();
  switchView('sale');
}

function openSaleForInventory(inventoryId) {
  resetSaleForm(false);
  renderSaleOptions(inventoryId);
  qs('#saleForm').inventoryId.value = inventoryId;
  renderSaleDetails();
  switchView('sale');
}

function resetExpenseForm() {
  const form = qs('#expenseForm');
  form.reset();
  form.id.value = '';
  form.createdAt.value = '';
  form.date.value = todayDate();
  form.category.value = '梱包資材';
  form.method.value = '現金';
  qs('#expenseEditingBadge').classList.add('hidden');
}

function fillExpenseForm(expense) {
  const form = qs('#expenseForm');
  Object.entries(expense).forEach(([key, value]) => { if (form[key] && typeof value !== 'object') form[key].value = value ?? ''; });
  qs('#expenseEditingBadge').classList.remove('hidden');
  openModal('expenseModal');
}

function setPreview(imgSelector, btnSelector, src) {
  const img = qs(imgSelector); const btn = qs(btnSelector);
  if (src) {
    img.src = src; img.classList.remove('hidden'); btn.classList.remove('hidden');
  } else {
    img.src = ''; img.classList.add('hidden'); btn.classList.add('hidden');
  }
}

function mergeMigrationData(data) {
  const merged = {
    inventory: [...state.inventory],
    sales: [...state.sales],
    expenses: [...state.expenses],
  };
  ['inventory', 'sales', 'expenses'].forEach((key) => {
    const map = new Map(merged[key].map((row) => [row.id, row]));
    (data[key] || []).forEach((row) => map.set(row.id || uid(key), row));
    merged[key] = [...map.values()];
  });
  return merged;
}

async function reloadState() {
  state.inventory = await getAll('inventory');
  state.sales = await getAll('sales');
  state.expenses = await getAll('expenses');
  renderAll();
}

function renderAll() {
  renderHome();
  renderInventory();
  renderSales();
  renderExpenseList();
  renderReviewList();
  renderAnalytics();
}

function buildCsvData() {
  const inventoryRows = [['id', '商品名', 'ブランド', 'カテゴリ', '仕入日', '仕入れ値', '数量', 'ステータス', '予定売価', 'ロット名', '保管場所']].concat(
    state.inventory.map((item) => [item.id, item.name, item.brand, item.category, item.purchaseDate, item.purchasePrice, item.quantity, item.status, item.plannedPrice, item.lotName, item.location])
  );
  const salesRows = [['id', 'inventoryId', '商品名', '販売日', '販売先', '販売単価', '数量', '手数料', '送料', '実受取額', '売上原価', '実利益']].concat(
    state.sales.map((sale) => {
      const inv = inventoryById(sale.inventoryId);
      const derived = calcSaleDerived(sale, inv);
      return [sale.id, sale.inventoryId, inv?.name || '', sale.saleDate, sale.platform, sale.salePrice, sale.saleQty, sale.platformFee, sale.shippingFee, derived.netAmount, derived.cogs, derived.realProfit];
    })
  );
  const expenseRows = [['id', '日付', '内容', '区分', '金額', '支払方法', 'メモ']].concat(
    state.expenses.map((expense) => [expense.id, expense.date, expense.title, expense.category, expense.amount, expense.method, expense.memo])
  );
  const ledgerRows = [['日付', '区分', '内容', '相手先', '売上', '経費', '原価', '利益']].concat([
    ...state.sales.map((sale) => {
      const inv = inventoryById(sale.inventoryId);
      const derived = calcSaleDerived(sale, inv);
      return [sale.saleDate, '販売', inv?.name || '', sale.platform || '', derived.grossSales, derived.platformFee + derived.shippingFee + derived.itemExpense, derived.cogs, derived.realProfit];
    }),
    ...state.expenses.map((expense) => [expense.date, '共通経費', expense.title || expense.category || '', expense.method || '', '', expense.amount, '', -safeNum(expense.amount)])
  ].sort((a, b) => new Date(a[0] || 0) - new Date(b[0] || 0)));
  return { inventoryRows, salesRows, expenseRows, ledgerRows };
}

function bindEvents() {
  qsa('.tab[data-nav], [data-nav]').forEach((el) => el.addEventListener('click', () => switchView(el.dataset.nav)));
  qsa('.close-modal').forEach((el) => el.addEventListener('click', () => closeModal(el.dataset.close)));
  ['expenseModal', 'reviewModal', 'settingsModal', 'confirmModal'].forEach((id) => {
    qs(`#${id}`)?.addEventListener('click', (event) => { if (event.target.id === id) closeModal(id); });
  });

  qs('#inventorySearch').addEventListener('input', (e) => { state.inventorySearch = e.target.value; renderInventory(); });
  qs('#inventorySort').addEventListener('change', (e) => { state.inventorySort = e.target.value; renderInventory(); });
  qs('#salesSearch').addEventListener('input', (e) => { state.saleSearch = e.target.value; renderSales(); });
  qs('#expenseSearch').addEventListener('input', (e) => { state.expenseSearch = e.target.value; renderExpenseList(); });
  qs('#summaryYearSelect').addEventListener('change', (e) => { state.analyticsYear = Number(e.target.value); renderAnalytics(); renderHome(); });
  qsa('.period-pill').forEach((btn) => btn.addEventListener('click', () => { state.analyticsPeriod = btn.dataset.summaryPeriod; renderAnalytics(); }));

  qs('#headerExpenseBtn').addEventListener('click', () => { resetExpenseForm(); renderExpenseList(); openModal('expenseModal'); });
  qs('#headerReviewBtn').addEventListener('click', () => { renderReviewList(); openModal('reviewModal'); });
  qs('#headerSettingsBtn').addEventListener('click', () => openModal('settingsModal'));
  qs('#homeOpenReviewBtn').addEventListener('click', () => openModal('reviewModal'));
  qs('#homeAllActivityBtn').addEventListener('click', () => switchView('sale'));
  qs('#homeQuickSaleBtn').addEventListener('click', () => switchView('sale'));
  qs('#homeOcrBtn').addEventListener('click', () => { switchView('sale'); toast('v6.0ではOCR導線を先に統合しています。画像OCR本体はv6.2で実装予定です。'); });
  qs('#quickBackupBtn').addEventListener('click', async () => {
    const payload = await exportAll();
    downloadBlob(`noirstock-backup-${todayDate()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  });

  qs('#inventoryResetBtn').addEventListener('click', () => resetInventoryForm(false));
  qs('#saleResetBtn').addEventListener('click', () => resetSaleForm(false));
  qs('#expenseResetBtn').addEventListener('click', () => resetExpenseForm());
  qs('#summaryTopProfitBtn').addEventListener('click', () => switchView('sale'));
  qs('#summaryPlatformBtn').addEventListener('click', () => switchView('sale'));

  qs('#inventoryPhotoInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    state.pendingInventoryPhoto = await fileToDataUrl(file);
    setPreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', state.pendingInventoryPhoto);
  });
  qs('#removeInventoryPhotoBtn').addEventListener('click', () => {
    state.pendingInventoryPhoto = null;
    qs('#inventoryPhotoInput').value = '';
    setPreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', null);
  });
  qs('#saleProofInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    state.pendingSaleProof = await fileToDataUrl(file);
    setPreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
  });
  qs('#removeSaleProofBtn').addEventListener('click', () => {
    state.pendingSaleProof = null;
    qs('#saleProofInput').value = '';
    setPreview('#saleProofPreview', '#removeSaleProofBtn', null);
  });

  qs('#saleInventorySelect').addEventListener('change', renderSaleDetails);
  qs('#saleForm').addEventListener('input', renderSaleDetails);
  qs('#parseSaleTextBtn').addEventListener('click', () => {
    state.saleParseResult = parseMercariText(qs('#saleParseText').value || '');
    renderSaleDetails();
    toast(Object.keys(state.saleParseResult).length ? '候補を解析しました' : '解析できる候補が見つかりませんでした');
  });
  qs('#applyAllCandidatesBtn').addEventListener('click', () => { applyAllCandidates(); renderSaleDetails(); });
  qs('#fillNetAmountBtn').addEventListener('click', () => {
    const form = qs('#saleForm');
    const qty = Math.max(1, safeNum(form.saleQty.value || 1));
    const value = Math.max(0, safeNum(form.salePrice.value) * qty - safeNum(form.platformFee.value) - safeNum(form.shippingFee.value));
    form.netAmount.value = value;
    renderSaleDetails();
  });
  qs('#ocrRetryBtn').addEventListener('click', () => toast('v6.0では画像OCR本体は未実装です。証跡画像の保存とテキスト解析導線を先に統合しています。'));

  qs('#inventoryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
      ...data,
      id: data.id || uid('inv'),
      createdAt: data.createdAt || new Date().toISOString(),
      purchasePrice: safeNum(data.purchasePrice),
      quantity: Math.max(1, safeNum(data.quantity || 1)),
      plannedPrice: safeNum(data.plannedPrice),
      photoDataUrl: state.pendingInventoryPhoto || '',
      updatedAt: new Date().toISOString(),
    };
    await put('inventory', payload);
    await reloadState();
    resetInventoryForm(false);
    toast('在庫を保存しました');
    switchView('inventory');
  });

  qs('#saleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const inv = inventoryById(data.inventoryId);
    if (!inv) { toast('対象商品を選択してください'); return; }
    const payload = {
      ...data,
      id: data.id || uid('sale'),
      createdAt: data.createdAt || new Date().toISOString(),
      saleQty: Math.max(1, safeNum(data.saleQty || 1)),
      salePrice: safeNum(data.salePrice),
      platformFee: safeNum(data.platformFee),
      shippingFee: safeNum(data.shippingFee),
      itemExpense: safeNum(data.itemExpense),
      netAmount: data.netAmount === '' ? '' : safeNum(data.netAmount),
      proofImageDataUrl: state.pendingSaleProof || '',
      updatedAt: new Date().toISOString(),
    };
    const remainBefore = remainingQty(inv, payload.id);
    if (payload.saleQty > remainBefore) { toast(`販売数量が在庫残数（${remainBefore}）を超えています`); return; }
    await put('sales', payload);
    const remainAfter = remainBefore - payload.saleQty;
    inv.status = remainAfter <= 0 ? '販売済' : '在庫中';
    await put('inventory', { ...inv, updatedAt: new Date().toISOString() });
    await reloadState();
    resetSaleForm(false);
    toast('販売を保存しました');
    switchView('sale');
  });

  qs('#expenseForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
      ...data,
      id: data.id || uid('exp'),
      createdAt: data.createdAt || new Date().toISOString(),
      amount: safeNum(data.amount),
      updatedAt: new Date().toISOString(),
    };
    await put('expenses', payload);
    await reloadState();
    resetExpenseForm();
    toast('経費を保存しました');
  });

  qs('#backupBtn').addEventListener('click', async () => {
    const payload = await exportAll();
    downloadBlob(`noirstock-backup-${todayDate()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  });
  qs('#restoreInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    openConfirm({ title: 'バックアップを復元', message: '現在のデータを置き換えて復元します。', okText: '復元', onOk: async () => {
      await bulkReplace({ inventory: data.inventory || [], sales: data.sales || [], expenses: data.expenses || [], settings: data.settings || [] });
      await reloadState();
      toast('バックアップを復元しました');
    }});
    event.target.value = '';
  });
  qs('#migrationInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    state.migrationData = JSON.parse(text);
    const invCount = (state.migrationData.inventory || []).length;
    const saleCount = (state.migrationData.sales || []).length;
    const expCount = (state.migrationData.expenses || []).length;
    qs('#migrationPreview').innerHTML = `<div class="muted">読込済み: 在庫 ${invCount}件 / 販売 ${saleCount}件 / 経費 ${expCount}件</div>`;
    event.target.value = '';
  });
  qs('#migrationMergeBtn').addEventListener('click', async () => {
    if (!state.migrationData) { toast('先に移行JSONを読み込んでください'); return; }
    const merged = mergeMigrationData(state.migrationData);
    await bulkReplace({ inventory: merged.inventory, sales: merged.sales, expenses: merged.expenses, settings: [] });
    await reloadState();
    toast('移行JSONを追加取込しました');
  });

  qs('#inventoryCsvBtn').addEventListener('click', () => {
    const { inventoryRows } = buildCsvData();
    downloadBlob(`noirstock_inventory_${todayDate()}.csv`, toCSV(inventoryRows), 'text/csv;charset=utf-8');
  });
  qs('#salesCsvBtn').addEventListener('click', () => {
    const { salesRows } = buildCsvData();
    downloadBlob(`noirstock_sales_${todayDate()}.csv`, toCSV(salesRows), 'text/csv;charset=utf-8');
  });
  qs('#expensesCsvBtn').addEventListener('click', () => {
    const { expenseRows } = buildCsvData();
    downloadBlob(`noirstock_expenses_${todayDate()}.csv`, toCSV(expenseRows), 'text/csv;charset=utf-8');
  });
  qs('#ledgerCsvBtn').addEventListener('click', () => {
    const { ledgerRows } = buildCsvData();
    downloadBlob(`noirstock_ledger_${todayDate()}.csv`, toCSV(ledgerRows), 'text/csv;charset=utf-8');
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    qs('#installBtn').classList.remove('hidden');
  });
  qs('#installBtn').addEventListener('click', async () => {
    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    qs('#installBtn').classList.add('hidden');
  });

  const updateConnectivity = () => {
    const online = navigator.onLine;
    qs('#offlineLabel').textContent = online ? 'オンライン' : 'オフライン';
    qs('#offlineDot').style.background = online ? '#67db86' : '#f1b547';
  };
  updateConnectivity();
  window.addEventListener('online', updateConnectivity);
  window.addEventListener('offline', updateConnectivity);
}

async function init() {
  bindEvents();
  renderSummaryYearOptions();
  resetInventoryForm(false);
  resetSaleForm(false);
  resetExpenseForm();
  await reloadState();
}

init();
