import { getAll, put, remove, exportAll, bulkReplace } from './db.js';
import {
  yen, pct, uid, safeNum, todayDate, nowLocalDateTime,
  monthKeyFromDateString, yearFromDateString, downloadBlob,
  toCSV, parseMercariText, escapeHtml, fileToDataUrl
} from './utils.js';

const state = {
  inventory: [], sales: [], expenses: [], currentView: 'home', deferredPrompt: null,
  pendingInventoryPhoto: null, pendingSaleProof: null, carryoverData: null, migrationData: null,
  saleParseResult: {}, inventoryFilter: 'all', inventorySort: 'updated'
};

const DRAFT_KEYS = {
  inventory: 'noirstock-draft-inventory-v5',
  sale: 'noirstock-draft-sale-v5',
  expense: 'noirstock-draft-expense-v5'
};

const views = ['home', 'inventory', 'register', 'sale', 'expense', 'summary', 'review', 'settings'];
const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];

function toast(message) {
  const el = qs('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function openConfirm({ title, message, okText = '実行', onOk }) {
  qs('#confirmTitle').textContent = title;
  qs('#confirmMessage').textContent = message;
  qs('#confirmOk').textContent = okText;
  qs('#confirmModal').classList.remove('hidden');
  qs('#confirmCancel').onclick = closeConfirm;
  qs('#confirmOk').onclick = async () => {
    closeConfirm();
    if (onOk) await onOk();
  };
}
function closeConfirm() { qs('#confirmModal').classList.add('hidden'); }

function inventoryItemById(id) { return state.inventory.find((item) => item.id === id) || null; }
function soldQtyForInventory(id, excludeSaleId = '') {
  return state.sales.filter((sale) => sale.inventoryId === id && sale.id !== excludeSaleId)
    .reduce((sum, sale) => sum + Math.max(1, safeNum(sale.saleQty || 1)), 0);
}
function currentQtyForInventory(item, excludeSaleId = '') {
  return Math.max(0, safeNum(item?.quantity || 1) - soldQtyForInventory(item?.id, excludeSaleId));
}
function calcSaleDerived(sale, inventoryItem) {
  const saleQty = Math.max(1, safeNum(sale.saleQty || 1));
  const salePrice = safeNum(sale.salePrice);
  const platformFee = safeNum(sale.platformFee);
  const shippingFee = safeNum(sale.shippingFee);
  const itemExpense = safeNum(sale.itemExpense);
  const netAmount = sale.netAmount !== '' && sale.netAmount !== null && sale.netAmount !== undefined
    ? safeNum(sale.netAmount)
    : Math.max(0, salePrice - platformFee - shippingFee);
  const purchaseUnit = safeNum(inventoryItem?.purchasePrice);
  const cogs = purchaseUnit * saleQty;
  const grossProfit = netAmount - cogs;
  const realProfit = grossProfit - itemExpense;
  const realMargin = netAmount > 0 ? realProfit / netAmount : 0;
  return { saleQty, salePrice, platformFee, shippingFee, itemExpense, netAmount, cogs, grossProfit, realProfit, realMargin };
}

function switchView(name) {
  state.currentView = name;
  views.forEach((viewName) => {
    qs(`#${viewName}View`)?.classList.toggle('active', viewName === name);
    qsa(`.tab[data-nav="${viewName}"]`).forEach((el) => el.classList.toggle('active', viewName === name));
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function serializeForm(form) { return Object.fromEntries(new FormData(form).entries()); }
function saveDraft(key, payload) { localStorage.setItem(key, JSON.stringify(payload)); }
function clearDraft(key) { localStorage.removeItem(key); }
function loadDraft(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function bindDraft(formSelector, key, extraGetter = () => ({})) {
  const form = qs(formSelector);
  const handler = () => saveDraft(key, { ...serializeForm(form), ...extraGetter() });
  form.addEventListener('input', handler);
  form.addEventListener('change', handler);
}

function setImagePreview(imgSelector, btnSelector, src) {
  const img = qs(imgSelector); const btn = qs(btnSelector);
  if (src) {
    img.src = src; img.classList.remove('hidden'); btn.classList.remove('hidden');
  } else {
    img.src = ''; img.classList.add('hidden'); btn.classList.add('hidden');
  }
}

function applyValuesToForm(form, data) {
  Object.entries(data || {}).forEach(([key, value]) => {
    if (form[key] && typeof value !== 'object') form[key].value = value ?? '';
  });
}

function resetInventoryForm(useDraft = false) {
  const form = qs('#inventoryForm');
  form.reset();
  form.id.value = '';
  form.createdAt.value = '';
  form.status.value = '在庫中';
  form.quantity.value = 1;
  state.pendingInventoryPhoto = null;
  qs('#inventoryEditingBadge').classList.add('hidden');
  setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', null);
  qs('#inventoryPhotoInput').value = '';
  if (useDraft) {
    const draft = loadDraft(DRAFT_KEYS.inventory);
    if (draft && !draft.id) applyValuesToForm(form, draft);
    state.pendingInventoryPhoto = draft?.pendingInventoryPhoto || null;
    setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', state.pendingInventoryPhoto);
  }
}

function resetSaleForm(useDraft = false) {
  const form = qs('#saleForm');
  form.reset();
  form.id.value = '';
  form.createdAt.value = '';
  form.saleQty.value = 1;
  form.platform.value = 'メルカリ';
  form.paymentMethod.value = '売上金';
  form.saleDate.value = nowLocalDateTime();
  qs('#saleParseText').value = '';
  state.saleParseResult = {};
  state.pendingSaleProof = null;
  setImagePreview('#saleProofPreview', '#removeSaleProofBtn', null);
  qs('#saleProofInput').value = '';
  qs('#saleEditingBadge').classList.add('hidden');
  if (useDraft) {
    const draft = loadDraft(DRAFT_KEYS.sale);
    if (draft && !draft.id) {
      applyValuesToForm(form, draft);
      qs('#saleParseText').value = draft.saleParseText || '';
    }
    state.pendingSaleProof = draft?.pendingSaleProof || null;
    setImagePreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
  }
  renderSaleOptions(form.inventoryId.value || '');
  renderSaleDetails();
}

function resetExpenseForm(useDraft = false) {
  const form = qs('#expenseForm');
  form.reset();
  form.id.value = '';
  form.createdAt.value = '';
  form.date.value = todayDate();
  form.category.value = '梱包資材';
  form.method.value = '現金';
  qs('#expenseEditingBadge').classList.add('hidden');
  if (useDraft) {
    const draft = loadDraft(DRAFT_KEYS.expense);
    if (draft && !draft.id) applyValuesToForm(form, draft);
  }
}

function fillInventoryForm(item) {
  const form = qs('#inventoryForm');
  applyValuesToForm(form, item);
  state.pendingInventoryPhoto = item.photoDataUrl || null;
  setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', state.pendingInventoryPhoto);
  qs('#inventoryEditingBadge').classList.remove('hidden');
  switchView('register');
}

function fillSaleForm(sale) {
  const form = qs('#saleForm');
  applyValuesToForm(form, sale);
  state.pendingSaleProof = sale.proofImageDataUrl || null;
  setImagePreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
  qs('#saleEditingBadge').classList.remove('hidden');
  renderSaleOptions(sale.inventoryId);
  renderSaleDetails();
  switchView('sale');
}

function fillExpenseForm(expense) {
  const form = qs('#expenseForm');
  applyValuesToForm(form, expense);
  qs('#expenseEditingBadge').classList.remove('hidden');
  switchView('expense');
}

function openSaleForInventory(inventoryId) {
  resetSaleForm(false);
  renderSaleOptions(inventoryId);
  qs('#saleForm').inventoryId.value = inventoryId;
  renderSaleDetails();
  switchView('sale');
}

function drawMiniLine(containerSelector, values, positiveColor = '#67db86') {
  const el = qs(containerSelector);
  if (!el) return;
  const width = 220; const height = 56; const pad = 4;
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : width - pad * 2;
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - (Math.abs(v) / max) * (height - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline fill="none" stroke="${positiveColor}" stroke-width="3" points="${points}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function drawMiniBars(containerSelector, values) {
  const el = qs(containerSelector);
  if (!el) return;
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  el.innerHTML = values.map((v) => `<span style="height:${Math.max(10, Math.round((Math.abs(v) / max) * 52))}px"></span>`).join('');
}

function reviewItems() {
  const issues = [];
  state.inventory.forEach((item) => {
    const missing = [];
    if (!item.name) missing.push('商品名');
    if (!safeNum(item.purchasePrice)) missing.push('仕入単価');
    if (!item.purchaseDate) missing.push('仕入日');
    if (!item.category) missing.push('カテゴリー');
    const remain = currentQtyForInventory(item);
    if ((item.status === '在庫中' || item.status === '出品中') && remain <= 0) missing.push('在庫数要確認');
    if (missing.length) issues.push({ type: 'inventory', id: item.id, title: item.name || '無題在庫', detail: missing.join(' / ') });
  });
  state.sales.forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const missing = [];
    if (!sale.saleDate) missing.push('販売日');
    if (!safeNum(sale.salePrice) && !safeNum(sale.netAmount)) missing.push('販売金額');
    if (!sale.platform) missing.push('販売先');
    if (!inv) missing.push('在庫紐づけ');
    if (missing.length) issues.push({ type: 'sale', id: sale.id, title: inv?.name || '販売データ', detail: missing.join(' / ') });
  });
  const map = new Map();
  state.inventory.forEach((item) => {
    const key = `${(item.name || '').trim().toLowerCase()}|${(item.brand || '').trim().toLowerCase()}|${item.purchaseDate || ''}`;
    if (!item.name) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  [...map.values()].filter((rows) => rows.length > 1).forEach((rows) => {
    issues.push({ type: 'inventory', id: rows[0].id, title: rows[0].name || '重複候補', detail: `重複候補 ${rows.length}件 / ${rows.map((r) => r.brand || '-').join(', ')}` });
  });
  return issues;
}

function aggregateYear(year) {
  const sales = state.sales.filter((sale) => yearFromDateString(sale.saleDate) === Number(year));
  const expenses = state.expenses.filter((expense) => yearFromDateString(expense.date) === Number(year));
  let salesTotal = 0;
  let cogsTotal = 0;
  let grossTotal = 0;
  let itemExpenseTotal = 0;
  const profitMap = [];
  const platformMap = new Map();
  sales.forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const derived = calcSaleDerived(sale, inv);
    salesTotal += derived.netAmount;
    cogsTotal += derived.cogs;
    grossTotal += derived.grossProfit;
    itemExpenseTotal += derived.itemExpense;
    profitMap.push({ name: inv?.name || '不明商品', profit: derived.realProfit, date: sale.saleDate, platform: sale.platform || '', sku: inv?.lotName || inv?.brand || '' });
    const key = sale.platform || 'その他';
    platformMap.set(key, (platformMap.get(key) || 0) + derived.realProfit);
  });
  const commonExpense = expenses.reduce((sum, expense) => sum + safeNum(expense.amount), 0);
  const netProfit = grossTotal - itemExpenseTotal - commonExpense;
  const margin = salesTotal > 0 ? netProfit / salesTotal : 0;
  return {
    salesTotal, cogsTotal, grossTotal, itemExpenseTotal, commonExpense, netProfit, margin,
    profitMap: profitMap.sort((a, b) => b.profit - a.profit).slice(0, 10),
    platformMap: [...platformMap.entries()].sort((a, b) => b[1] - a[1]),
    salesCount: sales.length, expenseCount: expenses.length
  };
}

function monthlyRows(year) {
  const rows = [];
  for (let m = 1; m <= 12; m += 1) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const sales = state.sales.filter((sale) => monthKeyFromDateString(sale.saleDate) === key);
    const expenses = state.expenses.filter((expense) => monthKeyFromDateString(expense.date) === key);
    let salesTotal = 0; let cogs = 0; let itemExpenses = 0; let realProfitTotal = 0;
    sales.forEach((sale) => {
      const inv = inventoryItemById(sale.inventoryId);
      const derived = calcSaleDerived(sale, inv);
      salesTotal += derived.netAmount;
      cogs += derived.cogs;
      itemExpenses += derived.itemExpense;
      realProfitTotal += derived.realProfit;
    });
    const commonExpense = expenses.reduce((sum, expense) => sum + safeNum(expense.amount), 0);
    rows.push({ month: `${m}月`, sales: salesTotal, cogs, gross: salesTotal - cogs, itemExpenses, commonExpense, net: realProfitTotal - commonExpense, count: sales.length });
  }
  return rows;
}

function inventoryStatusMeta(status) {
  if (status === '販売済') return { cls: 'status-sold', label: '販売済' };
  if (status === '出品中') return { cls: 'status-listed', label: '出品中' };
  if (status === '保留') return { cls: 'status-hold', label: '保留' };
  if (status === '要確認') return { cls: 'status-review', label: '要確認' };
  return { cls: 'status-stock', label: status || '在庫中' };
}

function inventoryCard(item) {
  const currentQty = currentQtyForInventory(item);
  const planned = safeNum(item.plannedPrice);
  const estProfit = planned - safeNum(item.purchasePrice);
  const estMargin = planned > 0 ? estProfit / planned : 0;
  const statusMeta = inventoryStatusMeta(item.status || '在庫中');
  const photo = item.photoDataUrl || 'assets/icon-192.png';
  const canSell = currentQty > 0 && item.status !== '販売済';
  return `
    <article class="inventory-card">
      <div class="inventory-top">
        <img class="item-thumb" src="${photo}" alt="${escapeHtml(item.name || '商品')}" />
        <div>
          <h3 class="item-title">${escapeHtml(item.name || '無題商品')}</h3>
          <div class="item-meta">
            <span>${escapeHtml(item.brand || 'ブランド未入力')}</span>
            <span>サイズ：${escapeHtml(item.size || '-')} ｜ カラー：${escapeHtml(item.color || '-')}</span>
            <span>SKU: ${escapeHtml(item.lotName || item.id)}</span>
          </div>
        </div>
        <div>
          <span class="status-pill ${statusMeta.cls}">${statusMeta.label}</span>
        </div>
      </div>
      <div class="item-finance">
        <div><span>仕入れ値</span><strong>${yen(item.purchasePrice || 0)}</strong></div>
        <div><span>想定売価</span><strong>${yen(planned)}</strong></div>
        <div><span>見込み利益</span><strong class="profit">${yen(estProfit)} ${planned ? `(${pct(estMargin)})` : ''}</strong></div>
      </div>
      <div class="status-editor">
        <div class="flow">
          <strong>ステータス変更</strong>
          <span class="inline-badge">残数 ${currentQty}</span>
          <select class="inventory-status-select" data-id="${item.id}">
            <option value="在庫中" ${item.status === '在庫中' ? 'selected' : ''}>在庫中</option>
            <option value="出品中" ${item.status === '出品中' ? 'selected' : ''}>出品中</option>
            <option value="販売済">販売済</option>
            <option value="保留" ${item.status === '保留' ? 'selected' : ''}>保留</option>
          </select>
          ${canSell ? `<button class="ghost quick-sale" data-id="${item.id}">販売入力</button>` : ''}
        </div>
        <div class="card-actions">
          <button class="ghost edit-inventory" data-id="${item.id}">編集</button>
          <button class="ghost apply-status" data-id="${item.id}">変更する</button>
          <button class="ghost danger-btn delete-inventory" data-id="${item.id}">削除</button>
        </div>
      </div>
    </article>`;
}

function renderInventory() {
  const search = (qs('#inventorySearch')?.value || '').trim().toLowerCase();
  const counts = {
    all: state.inventory.length,
    stock: state.inventory.filter((i) => i.status === '在庫中').length,
    listed: state.inventory.filter((i) => i.status === '出品中').length,
    review: reviewItems().filter((r) => r.type === 'inventory').length,
    sold: state.inventory.filter((i) => i.status === '販売済').length
  };
  qs('#inventoryStatusChips').innerHTML = [
    ['all', 'すべて', counts.all],
    ['在庫中', '在庫中', counts.stock],
    ['出品中', '出品中', counts.listed],
    ['要確認', '要確認', counts.review],
    ['販売済', '販売済', counts.sold]
  ].map(([key, label, count]) => `<button class="filter-chip ${state.inventoryFilter === key ? 'active' : ''}" data-filter="${key}">${label}<strong>${count}</strong></button>`).join('');

  let filtered = state.inventory.filter((item) => !search || `${item.name} ${item.brand} ${item.category} ${item.lotName || ''} ${item.id}`.toLowerCase().includes(search));
  if (state.inventoryFilter === '在庫中') filtered = filtered.filter((i) => i.status === '在庫中');
  if (state.inventoryFilter === '出品中') filtered = filtered.filter((i) => i.status === '出品中');
  if (state.inventoryFilter === '販売済') filtered = filtered.filter((i) => i.status === '販売済');
  if (state.inventoryFilter === '要確認') {
    const reviewIds = new Set(reviewItems().filter((r) => r.type === 'inventory').map((r) => r.id));
    filtered = filtered.filter((i) => reviewIds.has(i.id));
  }
  filtered = filtered.sort((a, b) => {
    if (state.inventorySort === 'profit') {
      const pa = safeNum(a.plannedPrice) - safeNum(a.purchasePrice);
      const pb = safeNum(b.plannedPrice) - safeNum(b.purchasePrice);
      return pb - pa;
    }
    if (state.inventorySort === 'purchase') return safeNum(b.purchasePrice) - safeNum(a.purchasePrice);
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  qs('#inventoryCountLabel').textContent = `${filtered.length}件`;
  qs('#inventoryList').innerHTML = filtered.length ? filtered.map(inventoryCard).join('') : '<div class="panel empty-state">在庫がまだありません。</div>';

  qsa('.filter-chip').forEach((btn) => btn.onclick = () => { state.inventoryFilter = btn.dataset.filter; renderInventory(); });
  qsa('.edit-inventory').forEach((btn) => btn.onclick = () => { const item = inventoryItemById(btn.dataset.id); if (item) fillInventoryForm(item); });
  qsa('.quick-sale').forEach((btn) => btn.onclick = () => openSaleForInventory(btn.dataset.id));
  qsa('.apply-status').forEach((btn) => btn.onclick = async () => {
    const item = inventoryItemById(btn.dataset.id);
    const target = qs(`.inventory-status-select[data-id="${btn.dataset.id}"]`)?.value || item?.status;
    if (!item || !target) return;
    if (target === '販売済') { openSaleForInventory(item.id); return; }
    item.status = target;
    await put('inventory', item);
    state.inventory = await getAll('inventory');
    refreshAll();
    toast('ステータスを更新しました');
  });
  qsa('.delete-inventory').forEach((btn) => btn.onclick = () => {
    const item = inventoryItemById(btn.dataset.id);
    if (!item) return;
    openConfirm({ title: '在庫を削除', message: `「${item.name}」を削除します。`, okText: '削除', onOk: async () => {
      await remove('inventory', item.id);
      state.inventory = await getAll('inventory');
      refreshAll();
      toast('在庫を削除しました');
    }});
  });
}

function renderSaleOptions(selectedId = '') {
  const select = qs('#saleInventorySelect');
  const editingSaleId = qs('#saleForm').id.value;
  const options = state.inventory.filter((item) => currentQtyForInventory(item, editingSaleId) > 0 || item.id === selectedId);
  select.innerHTML = '<option value="">選択してください</option>' + options.map((item) => {
    const remain = currentQtyForInventory(item, editingSaleId);
    const selected = item.id === selectedId ? 'selected' : '';
    return `<option value="${item.id}" ${selected}>${escapeHtml(item.name)} / ${escapeHtml(item.brand || '')} / 残${remain}</option>`;
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
  const pairs = [
    ['商品名', parsed.itemName],
    ['商品ID', parsed.externalItemId],
    ['販売単価', parsed.salePrice ? yen(parsed.salePrice) : ''],
    ['手数料', parsed.platformFee ? yen(parsed.platformFee) : ''],
    ['送料', parsed.shippingFee ? yen(parsed.shippingFee) : ''],
    ['販売日', parsed.saleDate]
  ].filter(([, val]) => val);
  wrap.innerHTML = pairs.length ? pairs.map(([label, value]) => `<button type="button" class="candidate-chip apply-candidate" data-key="${label}" data-value="${escapeHtml(String(value))}"><span>${label}</span><strong>${escapeHtml(String(value))}</strong><span class="ok">✓</span></button>`).join('') : '<div class="muted">候補はまだありません。テキスト解析を使うか、手で入力してください。</div>';
  qsa('.apply-candidate').forEach((btn) => btn.onclick = () => applyCandidate(btn.dataset.key));
}

function applyCandidate(label) {
  const form = qs('#saleForm');
  const parsed = state.saleParseResult || {};
  if (label === '商品ID') form.externalItemId.value = parsed.externalItemId || '';
  if (label === '販売単価') form.salePrice.value = safeNum(parsed.salePrice) || '';
  if (label === '手数料') form.platformFee.value = safeNum(parsed.platformFee) || '';
  if (label === '送料') form.shippingFee.value = safeNum(parsed.shippingFee) || '';
  if (label === '販売日' && parsed.saleDate) form.saleDate.value = parsed.saleDate;
  renderSaleDetails();
}

function renderSaleDetails() {
  const form = qs('#saleForm');
  const inv = inventoryItemById(form.inventoryId.value);
  const draft = Object.fromEntries(new FormData(form).entries());
  const derived = calcSaleDerived(draft, inv);
  renderSaleProductSummary(inv);
  renderSaleCandidates();
  qs('#salePreviewReal').textContent = yen(derived.realProfit);
  qs('#salePreviewMargin').textContent = pct(derived.realMargin);
  qs('#saleCalcBreakdown').innerHTML = [
    ['販売単価', yen(derived.salePrice)],
    ['販売手数料', `-${yen(derived.platformFee)}`],
    ['送料', `-${yen(derived.shippingFee)}`],
    ['仕入れ値（原価）', `-${yen(derived.cogs)}`]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function salesCard(sale) {
  const inv = inventoryItemById(sale.inventoryId);
  const derived = calcSaleDerived(sale, inv);
  return `
    <article class="sale-history-card">
      <div class="card-row"><strong>${escapeHtml(inv?.name || '不明商品')}</strong><span class="status-pill status-sold">${escapeHtml(sale.platform || '販売')}</span></div>
      <div class="card-row"><span class="muted">${new Date(sale.saleDate).toLocaleString('ja-JP')}</span><strong>${yen(derived.netAmount)}</strong></div>
      <div class="card-row"><span class="muted">実利益 ${pct(derived.realMargin)}</span><strong>${yen(derived.realProfit)}</strong></div>
      <div class="card-actions"><button class="ghost edit-sale" data-id="${sale.id}">編集</button><button class="ghost danger-btn delete-sale" data-id="${sale.id}">削除</button></div>
    </article>`;
}

function renderSales() {
  renderSaleOptions(qs('#saleForm').inventoryId.value);
  const search = (qs('#salesSearch')?.value || '').trim().toLowerCase();
  const sales = [...state.sales].filter((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const text = `${inv?.name || ''} ${sale.platform || ''} ${sale.externalItemId || ''}`.toLowerCase();
    return !search || text.includes(search);
  }).sort((a, b) => new Date(b.saleDate) - new Date(a.saleDate));
  qs('#salesList').innerHTML = sales.length ? sales.map(salesCard).join('') : '<div class="panel empty-state">販売履歴がまだありません。</div>';
  qsa('.edit-sale').forEach((btn) => btn.onclick = () => { const sale = state.sales.find((row) => row.id === btn.dataset.id); if (sale) fillSaleForm(sale); });
  qsa('.delete-sale').forEach((btn) => btn.onclick = () => {
    const sale = state.sales.find((row) => row.id === btn.dataset.id);
    const inv = inventoryItemById(sale?.inventoryId);
    if (!sale) return;
    openConfirm({ title: '販売履歴を削除', message: `「${inv?.name || '販売データ'}」の販売履歴を削除します。`, okText: '削除', onOk: async () => {
      await remove('sales', sale.id);
      state.sales = await getAll('sales');
      await syncInventoryStatuses();
      refreshAll();
      toast('販売履歴を削除しました');
    }});
  });
}

function expenseCard(expense) {
  return `
    <article class="expense-card">
      <div class="card-row"><strong>${escapeHtml(expense.title)}</strong><span class="inline-badge">${escapeHtml(expense.category)}</span></div>
      <div class="card-row"><span class="muted">${escapeHtml(expense.date)}</span><strong>${yen(expense.amount)}</strong></div>
      <div class="card-actions"><button class="ghost edit-expense" data-id="${expense.id}">編集</button><button class="ghost danger-btn delete-expense" data-id="${expense.id}">削除</button></div>
    </article>`;
}

function renderExpenses() {
  const search = (qs('#expenseSearch')?.value || '').trim().toLowerCase();
  const expenses = [...state.expenses]
    .filter((expense) => !search || `${expense.title} ${expense.category}`.toLowerCase().includes(search))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  qs('#expenseList').innerHTML = expenses.length ? expenses.map(expenseCard).join('') : '<div class="panel empty-state">経費データがまだありません。</div>';
  qsa('.edit-expense').forEach((btn) => btn.onclick = () => { const expense = state.expenses.find((row) => row.id === btn.dataset.id); if (expense) fillExpenseForm(expense); });
  qsa('.delete-expense').forEach((btn) => btn.onclick = () => {
    const expense = state.expenses.find((row) => row.id === btn.dataset.id);
    if (!expense) return;
    openConfirm({ title: '経費を削除', message: `「${expense.title}」を削除します。`, okText: '削除', onOk: async () => {
      await remove('expenses', expense.id);
      state.expenses = await getAll('expenses');
      refreshAll();
      toast('経費を削除しました');
    }});
  });
}

function renderHome() {
  const now = new Date();
  const y = now.getFullYear();
  const ym = `${y}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const todayKey = now.toLocaleDateString('sv-SE');
  const monthSales = state.sales.filter((sale) => monthKeyFromDateString(sale.saleDate) === ym);
  const todaySales = state.sales.filter((sale) => String(sale.saleDate || '').slice(0, 10) === todayKey);
  let todayNet = 0; let monthProfit = 0; let monthRevenue = 0;
  monthSales.forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const d = calcSaleDerived(sale, inv);
    monthProfit += d.realProfit; monthRevenue += d.netAmount;
  });
  todaySales.forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const d = calcSaleDerived(sale, inv);
    todayNet += d.netAmount;
  });
  const prevMonth = now.getMonth() === 0 ? `${y - 1}-12` : `${y}-${String(now.getMonth()).padStart(2, '0')}`;
  let prevRevenue = 0; let prevProfit = 0;
  state.sales.filter((sale) => monthKeyFromDateString(sale.saleDate) === prevMonth).forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const d = calcSaleDerived(sale, inv);
    prevRevenue += d.netAmount; prevProfit += d.realProfit;
  });
  const margin = monthRevenue > 0 ? monthProfit / monthRevenue : 0;
  const prevMargin = prevRevenue > 0 ? prevProfit / prevRevenue : 0;
  const delta = margin - prevMargin;

  qs('#homeTodaySales').textContent = yen(todayNet);
  qs('#homeTodaySalesCount').textContent = `${todaySales.length}件`;
  qs('#homeMonthProfit').textContent = yen(monthProfit);
  qs('#homeMonthProfitSub').textContent = `利益率 ${pct(margin)}`;
  qs('#homeMonthMargin').textContent = pct(margin);
  qs('#homeMonthMarginSub').textContent = `前月比 ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pt`;

  const review = reviewItems();
  const purchaseMissing = review.filter((r) => r.type === 'inventory' && r.detail.includes('仕入単価')).length;
  const ocrPending = state.sales.filter((s) => s.proofImageDataUrl && !s.externalItemId).length;
  qs('#homeAttentionList').innerHTML = `
    <div class="attention-row"><div class="left"><div class="attention-icon warn">!</div><div><strong>仕入れ値未入力</strong><div class="muted">利益計算に必要</div></div></div><div class="attention-count">${purchaseMissing}件</div></div>
    <div class="attention-row"><div class="left"><div class="attention-icon danger">!</div><div><strong>OCR未確定</strong><div class="muted">証跡画像あり / 商品ID未設定</div></div></div><div class="attention-count">${ocrPending}件</div></div>`;

  const activities = [];
  state.sales.forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    activities.push({
      at: new Date(sale.saleDate || sale.createdAt || 0).getTime(),
      icon: 'sale', title: '販売を登録しました', subtitle: inv?.name || '販売データ', time: sale.saleDate
    });
  });
  state.inventory.forEach((item) => activities.push({
    at: new Date(item.createdAt || 0).getTime(),
    icon: 'inventory', title: '在庫を追加しました', subtitle: item.name || '在庫', time: item.createdAt
  }));
  if (state.sales.some((s) => s.proofImageDataUrl)) {
    const row = [...state.sales].filter((s) => s.proofImageDataUrl).sort((a, b) => new Date(b.createdAt || b.saleDate) - new Date(a.createdAt || a.saleDate))[0];
    activities.push({ at: new Date(row.createdAt || row.saleDate).getTime(), icon: 'ocr', title: 'OCR素材を保存しました', subtitle: row.externalItemId || '取引証跡画像', time: row.saleDate || row.createdAt });
  }
  if (delta < 0) activities.push({ at: Date.now() - 1000, icon: 'review', title: '利益率が低下しています', subtitle: `利益率が前月比 ${(delta * 100).toFixed(1)}pt です`, time: now.toISOString() });
  activities.sort((a, b) => b.at - a.at);
  qs('#homeRecentActivity').innerHTML = activities.slice(0, 5).map((row) => `
    <div class="activity-row"><div class="activity-icon ${row.icon}">${row.icon === 'sale' ? '🛒' : row.icon === 'inventory' ? '◫' : row.icon === 'ocr' ? '◌' : '↘'}</div><div class="activity-main"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.subtitle || '')}</span></div><div class="activity-time">${row.time ? new Date(row.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : ''}</div></div>`).join('') || '<div class="muted">まだ活動がありません。</div>';

  const monthlyNetList = monthlyRows(y).map((r) => r.sales);
  const monthlyProfitList = monthlyRows(y).map((r) => r.net);
  drawMiniLine('#homeChartSales', monthlyNetList);
  drawMiniBars('#homeChartProfit', monthlyProfitList);
  drawMiniLine('#homeChartMargin', monthlyProfitList.map((v, i) => (monthlyNetList[i] ? v / monthlyNetList[i] : 0) * 100));
}

function renderTrendChart(rows) {
  const el = qs('#trendChart');
  const width = 900; const height = 320; const padL = 50; const padR = 20; const padT = 20; const padB = 34;
  const salesMax = Math.max(1, ...rows.map((r) => r.sales), ...rows.map((r) => Math.abs(r.net)));
  const xStep = (width - padL - padR) / Math.max(1, rows.length - 1);
  const y = (v) => height - padB - (Math.max(0, v) / salesMax) * (height - padT - padB);
  const x = (i) => padL + i * xStep;
  const salesPoints = rows.map((r, i) => `${x(i)},${y(r.sales)}`).join(' ');
  const netPoints = rows.map((r, i) => `${x(i)},${y(Math.max(0, r.net))}`).join(' ');
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const tooltipIndex = rows.findIndex((r) => r.sales === Math.max(...rows.map((x2) => x2.sales)));
  const t = rows[Math.max(0, tooltipIndex)];
  el.innerHTML = `<svg class="chart-surface" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    ${yTicks.map((f) => {
      const yy = height - padB - f * (height - padT - padB);
      return `<line x1="${padL}" y1="${yy}" x2="${width - padR}" y2="${yy}" stroke="rgba(255,255,255,.12)" stroke-dasharray="6 8" />`;
    }).join('')}
    ${rows.map((r, i) => `<text x="${x(i)}" y="${height - 8}" fill="rgba(210,220,232,.85)" font-size="12" text-anchor="middle">${r.month.replace('月','')}</text>`).join('')}
    <polyline fill="none" stroke="#67db86" stroke-width="4" points="${salesPoints}" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <polyline fill="none" stroke="#4fd18a" stroke-width="4" opacity="0.82" points="${netPoints}" stroke-linecap="round" stroke-linejoin="round"></polyline>
    ${tooltipIndex >= 0 ? `<line x1="${x(tooltipIndex)}" y1="${padT}" x2="${x(tooltipIndex)}" y2="${height - padB}" stroke="rgba(255,255,255,.2)" stroke-dasharray="5 6" />
      <circle cx="${x(tooltipIndex)}" cy="${y(t.sales)}" r="6" fill="#0b0d12" stroke="#67db86" stroke-width="3" />
      <circle cx="${x(tooltipIndex)}" cy="${y(Math.max(0, t.net))}" r="6" fill="#0b0d12" stroke="#4fd18a" stroke-width="3" />
      <g transform="translate(${Math.min(width - 180, x(tooltipIndex) + 16)}, ${padT + 12})">
        <rect width="150" height="78" rx="12" fill="rgba(17,20,26,.96)" stroke="rgba(255,255,255,.08)" />
        <text x="14" y="24" fill="#d7dfea" font-size="14">${escapeHtml(t.month)}</text>
        <text x="14" y="46" fill="#d7dfea" font-size="14">売上 ${yen(t.sales)}</text>
        <text x="14" y="66" fill="#67db86" font-size="14">実利益 ${yen(t.net)}</text>
      </g>` : ''}
  </svg>`;
}

function renderSummary() {
  const years = Array.from(new Set([
    ...state.inventory.map((item) => yearFromDateString(item.purchaseDate)).filter(Boolean),
    ...state.sales.map((sale) => yearFromDateString(sale.saleDate)).filter(Boolean),
    ...state.expenses.map((expense) => yearFromDateString(expense.date)).filter(Boolean),
    ...state.inventory.map((item) => Number(item.carryOverYear)).filter(Boolean),
    new Date().getFullYear()
  ])).sort((a, b) => b - a);
  const select = qs('#summaryYearSelect');
  const current = select.value || String(years[0] || new Date().getFullYear());
  select.innerHTML = years.map((year) => `<option value="${year}" ${String(year) === String(current) ? 'selected' : ''}>${year}年</option>`).join('');
  const year = Number(select.value || current);
  const agg = aggregateYear(year);
  const monthly = monthlyRows(year);

  qs('#sumSales').textContent = yen(agg.salesTotal);
  qs('#sumSalesSub').textContent = `${agg.salesCount}件`;
  qs('#sumNet').textContent = yen(agg.netProfit);
  qs('#sumNetSub').textContent = `利益率 ${pct(agg.margin)}`;
  qs('#sumMargin').textContent = pct(agg.margin);
  qs('#sumMarginSub').textContent = `経費 ${yen(agg.commonExpense + agg.itemExpenseTotal)}`;
  drawMiniLine('#summaryMiniSales', monthly.map((r) => r.sales));
  drawMiniBars('#summaryMiniNet', monthly.map((r) => r.net));
  drawMiniLine('#summaryMiniMargin', monthly.map((r) => (r.sales ? r.net / r.sales : 0) * 100));
  renderTrendChart(monthly);

  qs('#topProfitList').innerHTML = agg.profitMap.length ? agg.profitMap.slice(0, 5).map((item, index) => `
    <article class="sale-history-card">
      <div class="card-row"><div><strong>${index + 1}. ${escapeHtml(item.name)}</strong><div class="muted">${escapeHtml(item.sku || item.platform || '')}</div></div><strong>${yen(item.profit)}</strong></div>
      <div class="card-row"><span class="muted">${new Date(item.date).toLocaleDateString('ja-JP')}</span><span>${escapeHtml(item.platform)}</span></div>
    </article>`).join('') : '<div class="muted">まだ利益上位データがありません。</div>';

  const totalPlatform = Math.max(1, agg.platformMap.reduce((sum, [, v]) => sum + Math.max(0, v), 0));
  const colors = ['#67db86', '#4c8dff', '#d45a5a', '#8d95a3'];
  const segments = agg.platformMap.length ? agg.platformMap.map(([name, value], i) => ({ name, value, color: colors[i % colors.length], ratio: Math.max(0, value) / totalPlatform })) : [{ name: 'データなし', value: 0, color: '#8d95a3', ratio: 1 }];
  let acc = 0;
  const conic = segments.map((seg) => {
    const from = acc * 360; acc += seg.ratio; const to = acc * 360;
    return `${seg.color} ${from}deg ${to}deg`;
  }).join(', ');
  qs('#summaryBreakdown').innerHTML = `
    <div class="donut-wrap"><div class="donut" style="background:conic-gradient(${conic})"><div class="donut-center"><div class="muted">実利益合計</div><strong>${yen(agg.netProfit)}</strong></div></div></div>
    <div class="platform-rows">${segments.map((seg) => `<div class="platform-row"><span class="color-dot" style="background:${seg.color}"></span><span>${escapeHtml(seg.name)}</span><strong>${yen(seg.value)}</strong><span>${pct(seg.ratio)}</span></div>`).join('')}</div>`;
}

function renderReview() {
  const issues = reviewItems();
  qs('#reviewList').innerHTML = issues.length ? issues.map((issue) => `
    <article class="review-card">
      <div class="card-row"><strong>${escapeHtml(issue.title)}</strong><span class="inline-badge">${issue.type === 'inventory' ? '在庫' : '販売'}</span></div>
      <div class="muted">${escapeHtml(issue.detail)}</div>
      <div class="card-actions"><button class="ghost review-jump" data-type="${issue.type}" data-id="${issue.id}">開く</button></div>
    </article>`).join('') : '<div class="panel empty-state">要確認データはありません。</div>';
  qsa('.review-jump').forEach((btn) => btn.onclick = () => {
    if (btn.dataset.type === 'inventory') {
      const item = inventoryItemById(btn.dataset.id);
      if (item) fillInventoryForm(item);
    } else {
      const sale = state.sales.find((row) => row.id === btn.dataset.id);
      if (sale) fillSaleForm(sale);
    }
  });
}

async function syncInventoryStatuses() {
  for (const item of state.inventory) {
    const remain = currentQtyForInventory(item);
    if (remain <= 0) item.status = '販売済';
    else if (item.status === '販売済') item.status = '在庫中';
    await put('inventory', item);
  }
  state.inventory = await getAll('inventory');
}

function buildLedgerRows() {
  const rows = [['日付', '区分', '商品名', '販売先/内容', '数量', '売上', '原価', '商品別経費', '共通経費', '実利益', 'メモ']];
  [...state.sales].sort((a, b) => new Date(a.saleDate) - new Date(b.saleDate)).forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId); const derived = calcSaleDerived(sale, inv);
    rows.push([sale.saleDate, '売上', inv?.name || '', sale.platform || '', derived.saleQty, derived.netAmount, derived.cogs, derived.itemExpense, '', derived.realProfit, sale.note || '']);
  });
  [...state.expenses].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach((expense) => rows.push([expense.date, '共通経費', '', expense.title, '', '', '', '', expense.amount, -safeNum(expense.amount), expense.memo || '']));
  return rows;
}
function downloadLedgerCsv() { downloadBlob(`ledger-${todayDate()}.csv`, toCSV(buildLedgerRows()), 'text/csv;charset=utf-8'); toast('帳簿CSVを書き出しました'); }
function buildStoreCsvRows(storeName) {
  if (storeName === 'inventory') {
    const rows = [['id','商品名','ブランド','カテゴリー','仕入日','仕入単価','数量','残数','ステータス','前年繰越','ロット名','保管場所','仕入先','メモ']];
    state.inventory.forEach((item) => rows.push([item.id, item.name, item.brand, item.category, item.purchaseDate, item.purchasePrice, item.quantity, currentQtyForInventory(item), item.status, item.carryOverYear || '', item.lotName || '', item.location || '', item.supplier || '', item.memo || '']));
    return rows;
  }
  if (storeName === 'sales') {
    const rows = [['id','販売日','商品名','販売先','数量','商品代金','手数料','送料','商品別経費','受取額','実利益','商品ID','入金方法','メモ']];
    state.sales.forEach((sale) => {
      const inv = inventoryItemById(sale.inventoryId); const d = calcSaleDerived(sale, inv);
      rows.push([sale.id, sale.saleDate, inv?.name || '', sale.platform, d.saleQty, d.salePrice, d.platformFee, d.shippingFee, d.itemExpense, d.netAmount, d.realProfit, sale.externalItemId || '', sale.paymentMethod || '', sale.note || '']);
    });
    return rows;
  }
  const rows = [['id','日付','内容','金額','区分','支払方法','メモ']];
  state.expenses.forEach((e) => rows.push([e.id, e.date, e.title, e.amount, e.category, e.method, e.memo || '']));
  return rows;
}
function downloadStoreCsv(storeName, filename) { downloadBlob(filename, toCSV(buildStoreCsvRows(storeName)), 'text/csv;charset=utf-8'); toast('CSVを書き出しました'); }

function normalizeImportData(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return { inventory: Array.isArray(data.inventory) ? data.inventory : [], sales: Array.isArray(data.sales) ? data.sales : [], expenses: Array.isArray(data.expenses) ? data.expenses : [], settings: Array.isArray(data.settings) ? data.settings : [] };
}
function inferYearRange(data) {
  const years = [];
  [...(data.inventory || []), ...(data.sales || []), ...(data.expenses || [])].forEach((row) => {
    const date = row.saleDate || row.purchaseDate || row.date || '';
    const year = yearFromDateString(date);
    if (year) years.push(year);
  });
  if (!years.length) return '年情報なし';
  return `${Math.min(...years)}〜${Math.max(...years)}年`;
}
function renderMigrationPreview() {
  const wrap = qs('#migrationPreview'); if (!wrap) return;
  const data = state.migrationData?.data;
  if (!data) { wrap.innerHTML = '<div class="muted">移行用JSONを選ぶと件数を表示します。</div>'; return; }
  const yearLabel = inferYearRange(data);
  wrap.innerHTML = `<article class="review-card"><div class="card-row"><strong>${escapeHtml(state.migrationData.fileName || '移行JSON')}</strong><span class="inline-badge">${yearLabel}</span></div><div class="muted">在庫 ${data.inventory.length}件 / 販売 ${data.sales.length}件 / 経費 ${data.expenses.length}件</div></article>`;
}
function cloneWithUniqueId(row, prefix, usedIds, remap = null) {
  const cloned = { ...row }; const oldId = cloned.id || uid(prefix); let newId = oldId;
  while (usedIds.has(newId)) newId = uid(prefix);
  usedIds.add(newId); cloned.id = newId; if (remap) remap.set(oldId, newId); return cloned;
}
async function runMigrationImport(mode = 'replace') {
  const data = state.migrationData?.data;
  if (!data) { toast('先に移行JSONを選択してください'); return; }
  const normalized = normalizeImportData(data);
  if (mode === 'replace') await bulkReplace(normalized);
  else {
    const current = await exportAll();
    const invIds = new Set((current.inventory || []).map((r) => r.id));
    const saleIds = new Set((current.sales || []).map((r) => r.id));
    const expIds = new Set((current.expenses || []).map((r) => r.id));
    const inventoryIdRemap = new Map();
    const importedInventory = normalized.inventory.map((row) => cloneWithUniqueId(row, 'inv', invIds, inventoryIdRemap));
    const importedSales = normalized.sales.map((row) => {
      const cloned = { ...row };
      if (cloned.inventoryId && inventoryIdRemap.has(cloned.inventoryId)) cloned.inventoryId = inventoryIdRemap.get(cloned.inventoryId);
      return cloneWithUniqueId(cloned, 'sale', saleIds);
    });
    const importedExpenses = normalized.expenses.map((row) => cloneWithUniqueId(row, 'exp', expIds));
    await bulkReplace({ inventory: [...(current.inventory || []), ...importedInventory], sales: [...(current.sales || []), ...importedSales], expenses: [...(current.expenses || []), ...importedExpenses], settings: current.settings || [] });
  }
  state.migrationData = null; qs('#migrationInput').value = '';
  await loadState(); await refreshAll(); renderMigrationPreview(); toast(mode === 'replace' ? '移行データを取り込みました' : '移行データを追加取り込みしました');
}
function buildCarryoverPreview(data, sourceYear) {
  const prevInventory = data.inventory || []; const prevSales = data.sales || []; const year = Number(sourceYear);
  const saleQtyById = new Map();
  prevSales.filter((sale) => yearFromDateString(sale.saleDate) <= year).forEach((sale) => saleQtyById.set(sale.inventoryId, (saleQtyById.get(sale.inventoryId) || 0) + Math.max(1, safeNum(sale.saleQty || 1))));
  return prevInventory.map((item) => ({ source: item, remain: Math.max(0, safeNum(item.quantity || 1) - (saleQtyById.get(item.id) || 0)) }))
    .filter((row) => row.remain > 0 && yearFromDateString(row.source.purchaseDate) <= year);
}
function renderCarryoverPreview() {
  const wrap = qs('#carryoverPreview'); if (!wrap) return;
  const rows = state.carryoverData?.preview || [];
  wrap.innerHTML = rows.length ? rows.slice(0, 30).map((row) => `<article class="review-card"><div class="card-row"><strong>${escapeHtml(row.source.name || '無題')}</strong><span class="inline-badge">残${row.remain}</span></div><div class="muted">${escapeHtml(row.source.brand || '')} / 仕入 ${yen(row.source.purchasePrice || 0)} / ${state.carryoverData.sourceYear} → ${state.carryoverData.targetYear}</div></article>`).join('') + (rows.length > 30 ? `<div class="muted">他 ${rows.length - 30} 件</div>` : '') : '<div class="muted">プレビューはまだありません。</div>';
}
async function runCarryover() {
  if (!state.carryoverData?.preview?.length) { toast('先にプレビューしてください'); return; }
  const { preview, sourceYear, targetYear } = state.carryoverData;
  for (const row of preview) {
    const source = row.source;
    const cloned = { ...source, id: uid('inv'), createdAt: new Date().toISOString(), purchaseDate: `${targetYear}-01-01`, quantity: row.remain, status: '在庫中', carryOverYear: String(sourceYear), memo: `${source.memo || ''}\n[前年繰越] ${sourceYear}年末残在庫より作成`.trim() };
    await put('inventory', cloned);
  }
  await loadState(); refreshAll(); toast(`前年繰越 ${preview.length}件を作成しました`);
}

async function refreshAll() {
  renderHome(); renderInventory(); renderSales(); renderExpenses(); renderSummary(); renderReview(); renderCarryoverPreview(); renderMigrationPreview(); renderSaleDetails();
}
async function loadState() { state.inventory = await getAll('inventory'); state.sales = await getAll('sales'); state.expenses = await getAll('expenses'); }
function bindNav() { qsa('[data-nav]').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.nav))); }
function registerSW() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {}); }
function bindInstall() {
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.deferredPrompt = event; qs('#installBtn').classList.remove('hidden'); });
  qs('#installBtn').onclick = async () => { if (!state.deferredPrompt) return; await state.deferredPrompt.prompt(); state.deferredPrompt = null; qs('#installBtn').classList.add('hidden'); };
}
function exportBackup() { exportAll().then((payload) => { downloadBlob(`noirstock-backup-${todayDate()}.json`, JSON.stringify(payload, null, 2), 'application/json'); toast('JSONバックアップを書き出しました'); }); }
async function importBackup(file) { const text = await file.text(); await bulkReplace(normalizeImportData(JSON.parse(text))); await loadState(); refreshAll(); toast('バックアップを復元しました'); }

function bindForms() {
  qs('#inventoryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form).entries());
    const item = { ...payload, id: payload.id || uid('inv'), createdAt: payload.createdAt || new Date().toISOString(), quantity: Math.max(1, safeNum(payload.quantity || 1)), purchasePrice: safeNum(payload.purchasePrice), plannedPrice: safeNum(payload.plannedPrice), photoDataUrl: state.pendingInventoryPhoto || '' };
    await put('inventory', item); state.inventory = await getAll('inventory'); clearDraft(DRAFT_KEYS.inventory); resetInventoryForm(); refreshAll(); toast('在庫を保存しました');
    switchView('inventory');
  });
  qs('#saleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form).entries()); const inv = inventoryItemById(payload.inventoryId);
    if (!inv) return toast('対象商品を選択してください');
    const saleQty = Math.max(1, safeNum(payload.saleQty || 1)); const remain = currentQtyForInventory(inv, payload.id);
    if (saleQty > remain) return toast(`販売数量が在庫残数(${remain})を超えています`);
    const sale = { ...payload, id: payload.id || uid('sale'), createdAt: payload.createdAt || new Date().toISOString(), saleQty, salePrice: safeNum(payload.salePrice), platformFee: safeNum(payload.platformFee), shippingFee: safeNum(payload.shippingFee), itemExpense: safeNum(payload.itemExpense), netAmount: payload.netAmount === '' ? '' : safeNum(payload.netAmount), proofImageDataUrl: state.pendingSaleProof || '' };
    await put('sales', sale); state.sales = await getAll('sales'); await syncInventoryStatuses(); clearDraft(DRAFT_KEYS.sale); resetSaleForm(); refreshAll(); toast('販売結果を保存しました');
  });
  qs('#expenseForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form).entries());
    const expense = { ...payload, id: payload.id || uid('exp'), createdAt: payload.createdAt || new Date().toISOString(), amount: safeNum(payload.amount) };
    await put('expenses', expense); state.expenses = await getAll('expenses'); clearDraft(DRAFT_KEYS.expense); resetExpenseForm(); refreshAll(); toast('経費を保存しました');
  });
}

function bindButtons() {
  qs('#quickBackupBtn').onclick = exportBackup;
  qs('#backupBtn').onclick = exportBackup;
  qs('#homeOcrBtn').onclick = () => switchView('sale');
  qs('#homeAllActivityBtn').onclick = () => switchView('sale');
  qs('#headerExpenseBtn').onclick = () => switchView('expense');
  qs('#headerSettingsBtn').onclick = () => switchView('settings');
  qs('#inventoryCsvBtn').onclick = () => downloadStoreCsv('inventory', `inventory-${todayDate()}.csv`);
  qs('#salesCsvBtn').onclick = () => downloadStoreCsv('sales', `sales-${todayDate()}.csv`);
  qs('#expensesCsvBtn').onclick = () => downloadStoreCsv('expenses', `expenses-${todayDate()}.csv`);
  qs('#ledgerCsvBtn').onclick = downloadLedgerCsv;
  qs('#inventoryResetBtn').onclick = () => resetInventoryForm(true);
  qs('#saleResetBtn').onclick = () => { resetSaleForm(true); renderSaleOptions(); };
  qs('#expenseResetBtn').onclick = () => resetExpenseForm(true);
  qs('#parseSaleTextBtn').onclick = () => {
    const parsed = parseMercariText(qs('#saleParseText').value || '');
    state.saleParseResult = parsed;
    applyValuesToForm(qs('#saleForm'), parsed);
    renderSaleDetails();
    saveDraft(DRAFT_KEYS.sale, { ...serializeForm(qs('#saleForm')), saleParseText: qs('#saleParseText').value, pendingSaleProof: state.pendingSaleProof || '' });
    toast('テキスト解析を反映しました');
  };
  qs('#applyAllCandidatesBtn').onclick = () => {
    applyValuesToForm(qs('#saleForm'), state.saleParseResult || {});
    renderSaleDetails();
    toast('候補を反映しました');
  };
  qs('#ocrRetryBtn').onclick = () => toast('iPhoneではLive Textのコピー貼り付け併用がおすすめです');
  qs('#fillNetAmountBtn').onclick = () => {
    const form = qs('#saleForm');
    form.netAmount.value = Math.max(0, safeNum(form.salePrice.value) - safeNum(form.platformFee.value) - safeNum(form.shippingFee.value));
    renderSaleDetails();
  };
  qs('#removeInventoryPhotoBtn').onclick = () => {
    state.pendingInventoryPhoto = null; setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', null);
    saveDraft(DRAFT_KEYS.inventory, { ...serializeForm(qs('#inventoryForm')), pendingInventoryPhoto: '' });
  };
  qs('#removeSaleProofBtn').onclick = () => {
    state.pendingSaleProof = null; setImagePreview('#saleProofPreview', '#removeSaleProofBtn', null);
    saveDraft(DRAFT_KEYS.sale, { ...serializeForm(qs('#saleForm')), saleParseText: qs('#saleParseText').value, pendingSaleProof: '' });
  };
  qs('#inventoryPhotoInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return; state.pendingInventoryPhoto = await fileToDataUrl(file); setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', state.pendingInventoryPhoto); saveDraft(DRAFT_KEYS.inventory, { ...serializeForm(qs('#inventoryForm')), pendingInventoryPhoto: state.pendingInventoryPhoto });
  });
  qs('#saleProofInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return; state.pendingSaleProof = await fileToDataUrl(file); setImagePreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof); saveDraft(DRAFT_KEYS.sale, { ...serializeForm(qs('#saleForm')), saleParseText: qs('#saleParseText').value, pendingSaleProof: state.pendingSaleProof });
  });
  qs('#restoreInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return; openConfirm({ title: 'バックアップを復元', message: '現在のデータを置き換えます。続けますか？', okText: '復元', onOk: () => importBackup(file) });
  });
  qs('#migrationInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const text = await file.text(); state.migrationData = { fileName: file.name, data: normalizeImportData(JSON.parse(text)) }; renderMigrationPreview(); toast('移行JSONを読み込みました'); }
    catch (error) { console.error(error); toast('移行JSONの読み込みに失敗しました'); }
  });
  qs('#migrationReplaceBtn').onclick = () => openConfirm({ title: '移行データで置換', message: '現在の在庫・販売・経費データを置き換えます。続けますか？', okText: '置換', onOk: () => runMigrationImport('replace') });
  qs('#migrationMergeBtn').onclick = () => openConfirm({ title: '移行データを追加', message: '現在のデータを残したまま追加します。', okText: '追加', onOk: () => runMigrationImport('merge') });
  qs('#summaryYearSelect').addEventListener('change', renderSummary);
  qs('#saleForm').addEventListener('input', renderSaleDetails);
  qs('#saleForm').addEventListener('change', renderSaleDetails);
  qs('#saleInventorySelect').addEventListener('change', renderSaleDetails);
  qs('#inventorySearch').addEventListener('input', renderInventory);
  qs('#inventorySort').addEventListener('change', () => { state.inventorySort = qs('#inventorySort').value; renderInventory(); });
  qs('#salesSearch').addEventListener('input', renderSales);
  qs('#expenseSearch').addEventListener('input', renderExpenses);
  qs('#carryoverPreviewBtn').onclick = async () => {
    const file = qs('#carryoverBackupInput').files?.[0]; const sourceYear = qs('#carryoverSourceYear').value; const targetYear = qs('#carryoverTargetYear').value;
    if (!file || !sourceYear || !targetYear) return toast('バックアップ・元年・繰越先年を選択してください');
    const text = await file.text(); const data = JSON.parse(text);
    state.carryoverData = { raw: data, sourceYear, targetYear, preview: buildCarryoverPreview(data, sourceYear, targetYear) };
    renderCarryoverPreview(); toast(`プレビュー ${state.carryoverData.preview.length}件`);
  };
  qs('#carryoverRunBtn').onclick = () => openConfirm({ title: '前年繰越を実行', message: 'プレビューされた在庫を新規在庫として作成します。', okText: '作成', onOk: runCarryover });
}

async function boot() {
  bindNav(); registerSW(); bindInstall(); bindForms(); bindButtons();
  bindDraft('#inventoryForm', DRAFT_KEYS.inventory, () => ({ pendingInventoryPhoto: state.pendingInventoryPhoto || '' }));
  bindDraft('#saleForm', DRAFT_KEYS.sale, () => ({ saleParseText: qs('#saleParseText').value, pendingSaleProof: state.pendingSaleProof || '' }));
  bindDraft('#expenseForm', DRAFT_KEYS.expense);
  await loadState();
  resetInventoryForm(true); resetSaleForm(true); resetExpenseForm(true);
  await syncInventoryStatuses();
  await refreshAll();
}

boot().catch((error) => { console.error(error); toast('起動中にエラーが発生しました'); });
