import { getAll, put, remove, exportAll, bulkReplace, createAutoBackup } from './db.js';
import {
  yen, pct, uid, safeNum, todayDate, nowLocalDateTime,
  monthKeyFromDateString, yearFromDateString, downloadBlob,
  toCSV, parseMercariText, escapeHtml, fileToDataUrl
} from './utils.js';
import { APP_SCHEMA_VERSION, countDataset } from './schema.js';
import { normalizeToV62, datasetForStores, mergeDatasets, detectJsonShape } from './compat.js';
import { validateDataset } from './validator.js';
import { createEmptyOcrRecord, recordToParseResult, applyAcceptedField, saleOcrStatus, OCR_STATUS } from './ocrModel.js';
import { preprocessEvidenceImage } from './imagePreprocess.js';
import { runImageOcr } from './ocrController.js';
import { parseSaleEvidenceText } from './ocrParser.js';

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
  activeOcrRecord: null,
  ocrBusy: false,
  ocrProgress: '',
  migrationData: null,
  importPreviewData: null,
  importPreviewReport: null,
  lastValidationReport: null,
  lastValidationMode: '',
  ocrRecords: [],
  saleSheetSourceView: 'sale',
  saleSheetIntent: 'new',
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


function currentDatasetForCompat() {
  return {
    inventory: state.inventory,
    sales: state.sales,
    expenses: state.expenses,
    settings: [],
    ocrRecords: state.ocrRecords || [],
  };
}

function issueKindLabel(type) {
  return { inventory: '在庫', sale: '販売', expense: '経費', ocr: 'OCR' }[type] || '確認';
}

function issueCodeLabel(code) {
  const map = {
    inventory_missing_id: '在庫ID未入力',
    inventory_duplicate_id: '在庫ID重複',
    inventory_missing_name: '商品名未入力',
    inventory_missing_purchase_price: '仕入れ値未入力',
    inventory_missing_purchase_date: '仕入日未入力',
    sale_missing_id: '販売ID未入力',
    sale_missing_inventory_id: '在庫紐付けなし',
    sale_orphan_inventory_id: '在庫ID不一致',
    sale_missing_date: '販売日未入力',
    sale_missing_price: '販売単価未入力',
    ocr_unconfirmed: 'OCR未確定',
    expense_missing_id: '経費ID未入力',
    expense_missing_date: '経費日付未入力',
    expense_missing_amount: '経費金額未入力',
    ocr_missing_status: 'OCR状態未入力',
  };
  return map[code] || code || '確認';
}

function issueCanOpen(issue) {
  return ['inventory', 'sale', 'expense'].includes(issue?.type) && !!issue?.id;
}

function renderIssueCard(issue, idx, severity = 'warning') {
  const type = issue?.type || '';
  const canOpen = issueCanOpen(issue);
  const targetText = type ? issueKindLabel(type) : (issue?.row ? `${issue.row}行目` : '対象不明');
  const idText = issue?.id ? `<span class="muted issue-id">ID: ${escapeHtml(issue.id)}</span>` : '';
  const action = canOpen
    ? `<button type="button" class="ghost open-validation-target" data-type="${escapeHtml(type)}" data-id="${escapeHtml(issue.id)}">該当データを開く</button>`
    : `<button type="button" class="ghost" disabled>取り込み後に確認</button>`;
  return `
    <article class="validation-issue ${severity === 'error' ? 'issue-error' : 'issue-warning'}">
      <div class="validation-issue-main">
        <div class="card-row">
          <strong>${idx + 1}. ${escapeHtml(issueCodeLabel(issue?.code))}</strong>
          <span class="inline-badge">${escapeHtml(targetText)}</span>
        </div>
        <div class="muted">${escapeHtml(issue?.message || issue?.code || '確認が必要です。')}</div>
        ${idText}
      </div>
      <div class="card-actions">${action}</div>
    </article>`;
}

function attachValidationJumpHandlers(rootSelector = '#migrationPreview') {
  qsa(`${rootSelector} .open-validation-target`).forEach((btn) => {
    btn.onclick = () => openValidationTarget(btn.dataset.type, btn.dataset.id);
  });
}

function openValidationTarget(type, id) {
  if (!type || !id) { toast('開ける対象がありません'); return; }
  if (type === 'inventory') {
    const item = inventoryById(id);
    if (!item) { toast('該当する在庫が見つかりません'); return; }
    closeModal('settingsModal');
    closeModal('reviewModal');
    fillInventoryForm(item);
    toast('該当在庫を開きました');
    return;
  }
  if (type === 'sale') {
    const sale = saleById(id);
    if (!sale) { toast('該当する販売データが見つかりません'); return; }
    closeModal('settingsModal');
    closeModal('reviewModal');
    fillSaleForm(sale);
    toast('該当販売を開きました');
    return;
  }
  if (type === 'expense') {
    const expense = expenseById(id);
    if (!expense) { toast('該当する経費が見つかりません'); return; }
    closeModal('settingsModal');
    closeModal('reviewModal');
    resetExpenseForm();
    fillExpenseForm(expense);
    openModal('expenseModal');
    toast('該当経費を開きました');
    return;
  }
  toast('この警告は直接開けません');
}

function renderImportPreview(targetSelector, dataset, report, modeLabel = 'Import') {
  const el = qs(targetSelector);
  if (!el) return;
  const counts = report?.counts || countDataset(dataset);
  const errors = report?.errors || [];
  const warnings = report?.warnings || [];
  const shape = dataset?.meta?.sourceShape || 'unknown';
  const notes = dataset?.meta?.notes || [];
  const errorCards = errors.map((row, idx) => renderIssueCard(row, idx, 'error')).join('');
  const warningCards = warnings.map((row, idx) => renderIssueCard(row, idx, 'warning')).join('');
  const jumpHint = warnings.length || errors.length
    ? '<div class="muted">警告一覧の「該当データを開く」から修正画面へ移動できます。Import前のJSONでは、取り込み後に開けるようになります。</div>'
    : '<div class="muted">警告なし。既存データと互換性があります。</div>';
  el.innerHTML = `
    <div class="import-report">
      <div class="card-row"><strong>${escapeHtml(modeLabel)}プレビュー</strong><span class="inline-badge">schema ${APP_SCHEMA_VERSION}</span></div>
      <div class="muted">形式: ${escapeHtml(shape)} / 在庫 ${counts.inventory}件 / 販売 ${counts.sales}件 / 経費 ${counts.expenses}件 / OCR ${counts.ocrRecords}件</div>
      <div class="import-status ${errors.length ? 'danger' : 'ok'}">致命的エラー ${errors.length}件 / 警告 ${warnings.length}件</div>
      ${jumpHint}
      ${errors.length ? `<div class="import-errors"><div class="card-row"><strong>致命的エラー</strong><span>${errors.length}件</span></div><div class="validation-list">${errorCards}</div></div>` : ''}
      ${warnings.length ? `<div class="import-warnings"><div class="card-row"><strong>警告一覧</strong><span>${warnings.length}件</span></div><div class="validation-list">${warningCards}</div></div>` : '<div class="muted">警告なし</div>'}
      ${notes.length ? `<div class="muted">変換メモ: ${escapeHtml(notes.slice(0, 3).join(' / '))}${notes.length > 3 ? ' ...' : ''}</div>` : ''}
    </div>
  `;
  attachValidationJumpHandlers(targetSelector);
}

async function parseJsonFileToV62(file, mode = 'replace') {
  const text = await file.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const dataset = normalizeToV62({}, { mode });
    const report = { ok: false, errors: [{ severity: 'error', code: 'invalid_json', message: `JSONとして読めません: ${error.message}` }], warnings: [], counts: countDataset(dataset) };
    return { raw: {}, dataset, report, shape: 'invalid-json' };
  }
  const dataset = normalizeToV62(raw, { mode });
  const report = validateDataset(dataset);
  return { raw, dataset, report, shape: detectJsonShape(raw) };
}

async function replaceWithDatasetSafely(dataset, reason = 'before-import') {
  await createAutoBackup(reason);
  await bulkReplace(datasetForStores(dataset));
  await reloadState();
}

async function mergeDatasetSafely(dataset) {
  await createAutoBackup('before-merge-import');
  const merged = mergeDatasets(currentDatasetForCompat(), datasetForStores(dataset));
  await bulkReplace(merged);
  await reloadState();
}

function validateCurrentDataset(label = '現在データ検査') {
  const dataset = normalizeToV62(currentDatasetForCompat(), { mode: 'check' });
  const report = validateDataset(dataset);
  state.lastValidationReport = report;
  state.lastValidationMode = label;
  renderImportPreview('#migrationPreview', dataset, report, label);
  return report;
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

function normalizeNonSoldStatus(status) {
  return ['在庫中', '出品中', '保留', '要確認'].includes(status) ? status : '在庫中';
}

function calcSaleDerived(sale, inventoryItem) {
  const saleQty = Math.max(1, safeNum(sale.saleQty || 1));
  const salePrice = safeNum(sale.salePrice);
  const platformFee = safeNum(sale.platformFee);
  const shippingFee = safeNum(sale.shippingFee);
  const itemExpense = safeNum(sale.itemExpense);
  const purchaseUnit = safeNum(inventoryItem?.purchasePrice);
  const grossSales = salePrice * saleQty;
  const suggestedNetAmount = Math.max(0, grossSales - platformFee - shippingFee);
  const hasManualNet = sale.netAmount !== '' && sale.netAmount !== null && sale.netAmount !== undefined;
  const netAmount = hasManualNet ? safeNum(sale.netAmount) : suggestedNetAmount;
  const cogs = purchaseUnit * saleQty;
  const grossProfit = netAmount - cogs;
  const realProfit = grossProfit - itemExpense;
  const margin = grossSales > 0 ? realProfit / grossSales : 0;
  return {
    saleQty,
    salePrice,
    grossSales,
    platformFee,
    shippingFee,
    itemExpense,
    suggestedNetAmount,
    netAmount,
    cogs,
    grossProfit,
    realProfit,
    margin,
  };
}

function inferInventoryStatusAfterSale(item, sourceStatus, remainAfter) {
  if (remainAfter <= 0) return '販売済';
  return normalizeNonSoldStatus(sourceStatus || item?.status);
}

function buildSalePayload(data, inventoryItem, proofImageDataUrl) {
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
    proofImageDataUrl: proofImageDataUrl || data.proofImageDataUrl || '',
    ocrStatus: data.ocrStatus || ((data.ocrRecordId || state.activeOcrRecord?.id) ? '確定' : ((proofImageDataUrl || data.proofImageDataUrl) && !data.externalItemId ? '未確定' : 'なし')),
    ocrRecordId: data.ocrRecordId || state.activeOcrRecord?.id || '',
    sourceStatus: normalizeNonSoldStatus(data.sourceStatus || inventoryItem?.status),
    updatedAt: new Date().toISOString(),
  };
  payload._metrics = calcSaleDerived(payload, inventoryItem);
  return payload;
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
    if (saleOcrStatus(sale) === '未確定') missing.push('OCR未確定');
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
    { label: 'OCR未確定', count: state.sales.filter((sale) => saleOcrStatus(sale) === '未確定').length, cls: 'danger' },
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
            ${canSale ? `<button class="ghost quick-sale" data-id="${item.id}">販売入力シート</button>` : ''}
          </div>
          <div class="card-actions">
            <button class="ghost edit-inventory" data-id="${item.id}">編集</button>
            <button class="primary apply-status" data-id="${item.id}">変更する</button>
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
    if (target === '販売済') { openSaleForInventory(item.id, { sourceView: 'inventory', requestedStatus: target }); return; }
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
  const sourceStatus = qs('#saleForm')?.sourceStatus?.value || inv.status || '在庫中';
  const statusMeta = inventoryStatusMeta(sourceStatus || '在庫中');
  wrap.className = 'sale-product-summary';
  wrap.innerHTML = `
    <img class="item-thumb" src="${inv.photoDataUrl || 'assets/icon-192.png'}" alt="${escapeHtml(inv.name || '商品')}" />
    <div>
      <h3>${escapeHtml(inv.name || '')}</h3>
      <span class="status-pill ${statusMeta.cls}">${statusMeta.label}</span>
      <p>仕入れ値（原価） ${yen(inv.purchasePrice || 0)} / 残数 ${remainingQty(inv, qs('#saleForm')?.id?.value || '')}</p>
    </div>`;
}

function candidateRowsFromParseResult(parsed = {}) {
  const rows = [];
  const push = (key, label, value, confidence = 0.5) => {
    if (value === undefined || value === null || value === '') return;
    rows.push({ key, label, value, confidence });
  };
  if (Array.isArray(parsed._candidates)) {
    parsed._candidates.forEach((candidate) => push(candidate.field, candidate.label, candidate.value, candidate.confidence));
  } else {
    push('externalItemId', '商品ID', parsed.externalItemId, parsed._externalItemIdConfidence || 0.5);
    push('salePrice', '販売単価', parsed.salePrice ? yen(parsed.salePrice) : '', parsed._salePriceConfidence || 0.5);
    push('platformFee', '手数料', parsed.platformFee ? yen(parsed.platformFee) : '', parsed._platformFeeConfidence || 0.5);
    push('shippingFee', '送料', parsed.shippingFee ? yen(parsed.shippingFee) : '', parsed._shippingFeeConfidence || 0.5);
    push('netAmount', '販売利益/受取額', parsed.netAmount ? yen(parsed.netAmount) : '', parsed._netAmountConfidence || 0.5);
    push('saleDate', '販売日', parsed.saleDate || '', parsed._saleDateConfidence || 0.5);
    push('platform', '販売先', parsed.platform || '', parsed._platformConfidence || 0.5);
    push('shippingMethod', '配送方法', parsed.shippingMethod || '', parsed._shippingMethodConfidence || 0.5);
  }
  const seen = new Set();
  return rows.filter((row) => {
    const k = `${row.key}|${row.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

function renderSaleCandidates() {
  const wrap = qs('#ocrCandidateWrap');
  const parsed = state.saleParseResult || {};
  const rows = candidateRowsFromParseResult(parsed);
  const record = state.activeOcrRecord;
  const warningHtml = (parsed._warnings || record?.warnings || []).length
    ? `<div class="ocr-warning-list">${(parsed._warnings || record?.warnings || []).map((w) => `<div class="ocr-warning">⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
    : '';
  const status = record ? `<div class="ocr-status-line"><span class="inline-badge">OCR ${escapeHtml(record.status || 'pending')}</span><span class="muted">${escapeHtml(record.engine || 'manual')}</span></div>` : '';
  wrap.innerHTML = rows.length ? `${status}${rows.map(({ key, label, value, confidence }) => `
    <button type="button" class="candidate-chip apply-candidate" data-key="${escapeHtml(key)}" data-value="${escapeHtml(String(value))}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><span class="candidate-confidence">${Math.round((confidence || 0) * 100)}%</span><span class="ok">✓</span></button>
  `).join('')}${warningHtml}${parsed._rawText ? '<button type="button" id="showOcrRawBtn" class="ghost">OCR全文を確認</button>' : ''}` : `${status}<div class="muted">候補はまだありません。画像OCRを実行するか、テキスト貼り付け解析を使ってください。</div>${warningHtml}`;
  qsa('.apply-candidate').forEach((btn) => btn.onclick = () => applyCandidate(btn.dataset.key, btn.dataset.value));
  const rawBtn = qs('#showOcrRawBtn');
  if (rawBtn) rawBtn.onclick = () => {
    const raw = parsed._rawText || record?.rawText || '';
    if (raw) openConfirm({ title: 'OCR全文', message: raw.slice(0, 1800), okText: '閉じる' });
  };
}

function candidatePlainValue(key, explicitValue = '') {
  const parsed = state.saleParseResult || {};
  if (explicitValue) {
    if (['salePrice', 'platformFee', 'shippingFee', 'netAmount'].includes(key)) return safeNum(explicitValue);
    return explicitValue;
  }
  return parsed[key];
}

function applyCandidate(key, explicitValue = '') {
  const form = qs('#saleForm');
  const value = candidatePlainValue(key, explicitValue);
  if (value === undefined || value === null || value === '') return;
  if (key === 'externalItemId') form.externalItemId.value = value || '';
  if (key === 'salePrice') form.salePrice.value = safeNum(value) || '';
  if (key === 'platformFee') form.platformFee.value = safeNum(value) || '';
  if (key === 'shippingFee') form.shippingFee.value = safeNum(value) || '';
  if (key === 'netAmount') form.netAmount.value = safeNum(value) || '';
  if (key === 'saleDate' && value) form.saleDate.value = String(value).slice(0, 16);
  if (key === 'platform' && value) form.platform.value = value;
  if (key === 'shippingMethod' && value && form.shippingMethod) form.shippingMethod.value = value;
  if (state.activeOcrRecord) state.activeOcrRecord = applyAcceptedField(state.activeOcrRecord, key, value);
  renderSaleDetails();
}

function applyAllCandidates() {
  ['externalItemId', 'salePrice', 'platformFee', 'shippingFee', 'netAmount', 'saleDate', 'platform', 'shippingMethod'].forEach((key) => applyCandidate(key));
}

function renderSaleDetails() {
  const form = qs('#saleForm');
  const inv = inventoryById(form.inventoryId.value);
  if (inv && !form.sourceStatus.value) form.sourceStatus.value = normalizeNonSoldStatus(inv.status);
  renderSaleProductSummary(inv);
  renderSaleCandidates();
  if (qs('#ocrProgressLine')) {
    qs('#ocrProgressLine').textContent = state.ocrBusy ? `OCR処理中: ${state.ocrProgress || '処理中'}` : (state.activeOcrRecord?.status ? `OCR状態: ${state.activeOcrRecord.status}` : 'OCR未実行');
  }
  const draft = Object.fromEntries(new FormData(form).entries());
  const derived = calcSaleDerived(draft, inv);
  const remainBefore = inv ? remainingQty(inv, draft.id || '') : 0;
  const remainAfter = inv ? Math.max(0, remainBefore - derived.saleQty) : 0;
  qs('#salePreviewReal').textContent = yen(derived.realProfit);
  qs('#salePreviewMargin').textContent = pct(derived.margin);
  const context = inv
    ? `販売後ステータス: ${inferInventoryStatusAfterSale(inv, draft.sourceStatus, remainAfter)} / 残数 ${remainAfter}`
    : '共通計算エンジン';
  if (qs('#saleCalcContext')) qs('#saleCalcContext').textContent = context;
  qs('#saleCalcBreakdown').innerHTML = [
    ['売上', yen(derived.grossSales)],
    ['販売手数料', `-${yen(derived.platformFee)}`],
    ['送料', `-${yen(derived.shippingFee)}`],
    ['売上原価', `-${yen(derived.cogs)}`],
    ['商品別追加経費', `-${yen(derived.itemExpense)}`],
    ['実受取額', yen(derived.netAmount)],
    ['販売前残数', inv ? String(remainBefore) : '-'],
    ['販売後残数', inv ? String(remainAfter) : '-'],
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
        <div class="card-row"><span class="muted">実利益 ${pct(derived.margin)} / OCR ${escapeHtml(saleOcrStatus(sale))}</span><strong>${yen(derived.realProfit)}</strong></div>
        <div class="card-actions"><button class="ghost edit-sale" data-id="${sale.id}">編集</button><button class="ghost revert-sale" data-id="${sale.id}">在庫へ戻す</button><button class="ghost danger-btn delete-sale" data-id="${sale.id}">削除</button></div>
      </article>`;
  }).join('') : '<div class="muted">販売履歴はまだありません。</div>';

  qsa('.edit-sale').forEach((btn) => btn.onclick = () => { const sale = saleById(btn.dataset.id); if (sale) fillSaleForm(sale); });
  qsa('.revert-sale').forEach((btn) => btn.onclick = () => {
    const sale = saleById(btn.dataset.id); const inv = inventoryById(sale?.inventoryId);
    if (!sale || !inv) return;
    openConfirm({ title: '販売を取り消す', message: `「${inv.name || '商品'}」を在庫へ戻します。`, okText: '取り消す', onOk: async () => {
      const remainingWithoutSale = Math.max(0, safeNum(inv.quantity || 1) - state.sales.filter((row) => row.inventoryId === inv.id && row.id !== sale.id).reduce((sum, row) => sum + Math.max(1, safeNum(row.saleQty || 1)), 0));
      await remove('sales', sale.id);
      inv.status = remainingWithoutSale <= 0 ? '販売済' : normalizeNonSoldStatus(sale.sourceStatus || inv.status);
      await put('inventory', { ...inv, updatedAt: new Date().toISOString() });
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

function setSaleSheetMeta({ intent = 'new', sourceView = 'sale', title = '', subtitle = '' } = {}) {
  state.saleSheetIntent = intent;
  state.saleSheetSourceView = sourceView;
  qs('#saleSheetTitle').textContent = title || (intent === 'edit' ? '販売入力シート（編集）' : '販売入力シート');
  qs('#saleSheetSubtitle').textContent = subtitle || (sourceView === 'inventory'
    ? '在庫の状態変更から販売確定までを一本化'
    : '販売履歴から編集、または在庫を選んで新規登録');
}

function openSaleSheet() { openModal('saleSheetModal'); }
function closeSaleSheet() { closeModal('saleSheetModal'); }

function resetSaleForm() {
  const form = qs('#saleForm');
  form.reset();
  form.id.value = '';
  form.createdAt.value = '';
  form.sourceStatus.value = '在庫中';
  form.saleQty.value = 1;
  form.platform.value = 'メルカリ';
  form.paymentMethod.value = '売上金';
  form.saleDate.value = nowLocalDateTime();
  state.pendingSaleProof = null;
  state.saleParseResult = {};
  state.activeOcrRecord = null;
  state.ocrBusy = false;
  state.ocrProgress = '';
  qs('#saleEditingBadge').classList.add('hidden');
  qs('#saleParseText').value = '';
  qs('#saleProofInput').value = '';
  setPreview('#saleProofPreview', '#removeSaleProofBtn', null);
  renderSaleOptions();
  renderSaleDetails();
}

function fillSaleForm(sale) {
  const form = qs('#saleForm');
  resetSaleForm();
  Object.entries(sale).forEach(([key, value]) => { if (form[key] && typeof value !== 'object') form[key].value = value ?? ''; });
  form.sourceStatus.value = normalizeNonSoldStatus(sale.sourceStatus || inventoryById(sale.inventoryId)?.status || '在庫中');
  qs('#saleEditingBadge').classList.remove('hidden');
  state.pendingSaleProof = sale.proofImageDataUrl || null;
  state.activeOcrRecord = state.ocrRecords.find((row) => row.id === sale.ocrRecordId) || null;
  state.saleParseResult = state.activeOcrRecord ? recordToParseResult(state.activeOcrRecord) : {};
  setPreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
  renderSaleOptions(sale.inventoryId);
  renderSaleDetails();
  setSaleSheetMeta({ intent: 'edit', sourceView: 'sale', title: '販売入力シート（編集）', subtitle: '販売履歴を編集すると利益と在庫状態を再計算します' });
  openSaleSheet();
}

function openSaleForInventory(inventoryId, { sourceView = 'inventory', requestedStatus = '販売済' } = {}) {
  resetSaleForm();
  const item = inventoryById(inventoryId);
  renderSaleOptions(inventoryId);
  qs('#saleForm').inventoryId.value = inventoryId;
  qs('#saleForm').sourceStatus.value = normalizeNonSoldStatus(item?.status || requestedStatus || '在庫中');
  renderSaleDetails();
  setSaleSheetMeta({ intent: 'new', sourceView, title: '販売入力シート', subtitle: sourceView === 'inventory' ? '在庫の状態変更から販売を確定します' : '対象商品を選んで販売を登録します' });
  openSaleSheet();
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
  const normalized = data?.schemaVersion ? data : normalizeToV62(data || {}, { mode: 'merge' });
  return mergeDatasets(currentDatasetForCompat(), datasetForStores(normalized));
}

async function reloadState() {
  state.inventory = await getAll('inventory');
  state.sales = await getAll('sales');
  state.expenses = await getAll('expenses');
  state.ocrRecords = await getAll('ocrRecords');
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
  ['saleSheetModal', 'expenseModal', 'reviewModal', 'settingsModal', 'confirmModal'].forEach((id) => {
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
  qs('#homeQuickSaleBtn').addEventListener('click', () => { switchView('sale'); setSaleSheetMeta({ intent: 'new', sourceView: 'sale' }); openSaleSheet(); });
  qs('#homeOcrBtn').addEventListener('click', () => { switchView('sale'); setSaleSheetMeta({ intent: 'new', sourceView: 'sale', subtitle: 'OCR候補の準備と販売証跡の保存ができます' }); openSaleSheet(); toast('販売証跡画像を選び、画像OCRまたはテキスト貼り付け解析を使えます。'); });
  qs('#quickBackupBtn').addEventListener('click', async () => {
    const payload = await exportAll();
    downloadBlob(`noirstock_backup_v6_3_${todayDate()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  });

  qs('#inventoryResetBtn').addEventListener('click', () => resetInventoryForm(false));
  qs('#saleResetBtn').addEventListener('click', () => { resetSaleForm(); renderSaleOptions(qs('#saleForm').inventoryId.value || ''); openSaleSheet(); });
  qs('#saleOpenSheetBtn').addEventListener('click', () => { resetSaleForm(); setSaleSheetMeta({ intent: 'new', sourceView: 'sale', subtitle: '対象商品を選んで販売を登録します' }); openSaleSheet(); });
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
    try {
      toast('証跡画像を準備しています');
      const rawDataUrl = await fileToDataUrl(file);
      const processed = await preprocessEvidenceImage(rawDataUrl);
      state.pendingSaleProof = processed.dataUrl;
      state.activeOcrRecord = createEmptyOcrRecord({
        sourceType: 'saleEvidence',
        imageDataUrl: processed.dataUrl,
        imageMeta: processed,
        linkedInventoryId: qs('#saleForm').inventoryId.value || '',
        status: OCR_STATUS.PENDING,
      });
      state.saleParseResult = {};
      setPreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
      renderSaleDetails();
      toast('証跡画像を保存しました。画像OCRを実行できます');
    } catch (error) {
      toast(`画像の準備に失敗しました: ${error.message}`);
    }
  });
  qs('#removeSaleProofBtn').addEventListener('click', () => {
    state.pendingSaleProof = null;
    state.activeOcrRecord = null;
    state.saleParseResult = {};
    qs('#saleProofInput').value = '';
    setPreview('#saleProofPreview', '#removeSaleProofBtn', null);
    renderSaleDetails();
  });

  qs('#saleInventorySelect').addEventListener('change', () => { const inv = inventoryById(qs('#saleInventorySelect').value); if (inv && !qs('#saleForm').id.value) qs('#saleForm').sourceStatus.value = normalizeNonSoldStatus(inv.status); if (state.activeOcrRecord) state.activeOcrRecord.linkedInventoryId = qs('#saleInventorySelect').value || ''; renderSaleDetails(); });
  qs('#saleForm').addEventListener('input', renderSaleDetails);
  qs('#parseSaleTextBtn').addEventListener('click', () => {
    const rawText = qs('#saleParseText').value || '';
    const parsed = parseSaleEvidenceText(rawText);
    state.saleParseResult = parsed;
    state.activeOcrRecord = createEmptyOcrRecord({
      ...(state.activeOcrRecord || {}),
      rawText: parsed._rawText || rawText,
      engine: state.activeOcrRecord?.engine || 'manualPaste',
      status: parsed._candidates?.length ? OCR_STATUS.PARSED : OCR_STATUS.FAILED,
      candidates: parsed._candidates || [],
      warnings: parsed._warnings || [],
      imageDataUrl: state.pendingSaleProof || state.activeOcrRecord?.imageDataUrl || '',
      linkedInventoryId: qs('#saleForm').inventoryId.value || '',
    });
    renderSaleDetails();
    toast((parsed._candidates || []).length ? 'OCR候補を解析しました' : '解析できる候補が見つかりませんでした');
  });
  qs('#applyAllCandidatesBtn').addEventListener('click', () => { applyAllCandidates(); renderSaleDetails(); });
  qs('#fillNetAmountBtn').addEventListener('click', () => {
    const form = qs('#saleForm');
    const qty = Math.max(1, safeNum(form.saleQty.value || 1));
    const value = Math.max(0, safeNum(form.salePrice.value) * qty - safeNum(form.platformFee.value) - safeNum(form.shippingFee.value));
    form.netAmount.value = value;
    renderSaleDetails();
  });
  qs('#ocrRetryBtn').addEventListener('click', async () => {
    if (!state.pendingSaleProof && !state.activeOcrRecord?.imageDataUrl) {
      toast('先に販売証跡画像を選択してください');
      return;
    }
    if (state.ocrBusy) { toast('OCR処理中です'); return; }
    state.ocrBusy = true;
    state.ocrProgress = 'OCR準備中';
    renderSaleDetails();
    try {
      const targetImage = state.pendingSaleProof || state.activeOcrRecord.imageDataUrl;
      if (!state.activeOcrRecord) {
        state.activeOcrRecord = createEmptyOcrRecord({ sourceType: 'saleEvidence', imageDataUrl: targetImage, linkedInventoryId: qs('#saleForm').inventoryId.value || '' });
      }
      state.activeOcrRecord.status = OCR_STATUS.PROCESSING;
      const ocr = await runImageOcr(targetImage, { onProgress: ({ stage }) => { state.ocrProgress = stage; renderSaleDetails(); } });
      const parsed = parseSaleEvidenceText(ocr.rawText || '');
      state.saleParseResult = parsed;
      state.activeOcrRecord = createEmptyOcrRecord({
        ...state.activeOcrRecord,
        rawText: parsed._rawText || ocr.rawText || '',
        engine: ocr.engine || 'browser-ocr',
        status: parsed._candidates?.length ? OCR_STATUS.PARSED : OCR_STATUS.FAILED,
        candidates: parsed._candidates || [],
        warnings: parsed._warnings || [],
        linkedInventoryId: qs('#saleForm').inventoryId.value || state.activeOcrRecord.linkedInventoryId || '',
      });
      toast((parsed._candidates || []).length ? '画像OCRから候補を抽出しました' : 'OCR文字は取れましたが候補が不足しています');
    } catch (error) {
      state.activeOcrRecord = createEmptyOcrRecord({
        ...(state.activeOcrRecord || {}),
        imageDataUrl: state.pendingSaleProof || state.activeOcrRecord?.imageDataUrl || '',
        status: OCR_STATUS.FAILED,
        engine: 'browser-ocr-unavailable',
        warnings: [error.message || 'OCRに失敗しました'],
      });
      toast('画像OCRを利用できません。文字貼り付け解析を使ってください');
    } finally {
      state.ocrBusy = false;
      state.ocrProgress = '';
      renderSaleDetails();
    }
  });

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
    if (state.activeOcrRecord) {
      state.activeOcrRecord = createEmptyOcrRecord({
        ...state.activeOcrRecord,
        status: Object.keys(state.activeOcrRecord.acceptedFields || {}).length ? OCR_STATUS.CONFIRMED : state.activeOcrRecord.status,
        linkedInventoryId: data.inventoryId,
        imageDataUrl: state.pendingSaleProof || state.activeOcrRecord.imageDataUrl || '',
      });
      data.ocrRecordId = state.activeOcrRecord.id;
      data.ocrStatus = state.activeOcrRecord.status === OCR_STATUS.CONFIRMED ? '確定' : '候補あり';
    }
    const payload = buildSalePayload(data, inv, state.pendingSaleProof || '');
    const remainBefore = remainingQty(inv, payload.id);
    if (payload.saleQty > remainBefore) { toast(`販売数量が在庫残数（${remainBefore}）を超えています`); return; }
    if (state.activeOcrRecord) {
      state.activeOcrRecord.linkedSaleId = payload.id;
      await put('ocrRecords', state.activeOcrRecord);
      payload.ocrRecordId = state.activeOcrRecord.id;
    }
    await put('sales', payload);
    const remainAfter = remainBefore - payload.saleQty;
    inv.status = inferInventoryStatusAfterSale(inv, payload.sourceStatus, remainAfter);
    await put('inventory', { ...inv, updatedAt: new Date().toISOString() });
    await reloadState();
    resetSaleForm();
    closeSaleSheet();
    toast('販売を保存しました');
    switchView(state.saleSheetSourceView || 'sale');
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
    downloadBlob(`noirstock_backup_v6_3_${todayDate()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  });
  qs('#restoreInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const { dataset, report, shape } = await parseJsonFileToV62(file, 'replace');
    state.importPreviewData = dataset;
    state.importPreviewReport = report;
    renderImportPreview('#migrationPreview', dataset, report, '全置換');
    if (report.errors.length) {
      toast('致命的エラーがあるため復元できません');
      event.target.value = '';
      return;
    }
    openConfirm({
      title: 'v6.3形式で復元',
      message: `形式: ${shape} / 在庫 ${report.counts.inventory}件 / 販売 ${report.counts.sales}件 / 経費 ${report.counts.expenses}件。現在データを自動バックアップしてから全置換します。`,
      okText: '復元',
      onOk: async () => {
        await replaceWithDatasetSafely(dataset, 'before-restore-v6.3');
        const postReport = validateCurrentDataset('Import後の警告一覧');
        toast(postReport.warnings.length ? `復元しました。警告 ${postReport.warnings.length}件を確認してください` : 'v6.3形式で復元しました');
      }
    });
    event.target.value = '';
  });
  qs('#migrationInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const { dataset, report } = await parseJsonFileToV62(file, 'merge');
    state.migrationData = dataset;
    state.importPreviewData = dataset;
    state.importPreviewReport = report;
    renderImportPreview('#migrationPreview', dataset, report, '追加取込');
    if (report.errors.length) toast('致命的エラーがあるため追加取込できません');
    event.target.value = '';
  });
  qs('#migrationMergeBtn').addEventListener('click', async () => {
    if (!state.migrationData) { toast('先に移行JSONを読み込んでください'); return; }
    const report = state.importPreviewReport || validateDataset(state.migrationData);
    if (report.errors?.length) { toast('致命的エラーがあるため追加取込できません'); return; }
    openConfirm({
      title: '追加取込を実行',
      message: `在庫 ${report.counts.inventory}件 / 販売 ${report.counts.sales}件 / 経費 ${report.counts.expenses}件を追加取込します。現在データは自動バックアップされます。`,
      okText: '追加取込',
      onOk: async () => {
        await mergeDatasetSafely(state.migrationData);
        state.migrationData = null;
        state.importPreviewData = null;
        state.importPreviewReport = null;
        const postReport = validateCurrentDataset('追加取込後の警告一覧');
        toast(postReport.warnings.length ? `追加取込しました。警告 ${postReport.warnings.length}件を確認してください` : '移行JSONを追加取込しました');
      }
    });
  });

  qs('#dataCheckBtn')?.addEventListener('click', () => {
    const report = validateCurrentDataset('現在データ検査 / 警告一覧');
    toast(report.errors.length ? '致命的エラーがあります' : `検査完了: 警告 ${report.warnings.length}件`);
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
  resetSaleForm();
  resetExpenseForm();
  await reloadState();
}

init();
