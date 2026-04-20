import { getAll, put, remove, exportAll, bulkReplace } from './db.js';
import {
  yen, pct, uid, safeNum, todayDate, nowLocalDateTime,
  monthKeyFromDateString, yearFromDateString, downloadBlob,
  toCSV, parseMercariText, escapeHtml, fileToDataUrl
} from './utils.js';

const state = {
  inventory: [], sales: [], expenses: [], currentView: 'home', deferredPrompt: null,
  pendingInventoryPhoto: null, pendingSaleProof: null, carryoverData: null, migrationData: null
};

const DRAFT_KEYS = {
  inventory: 'noirstock-draft-inventory-v3',
  sale: 'noirstock-draft-sale-v3',
  expense: 'noirstock-draft-expense-v3'
};

const views = ['home', 'inventory', 'sale', 'expense', 'summary', 'review', 'settings'];
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
  return state.sales
    .filter((sale) => sale.inventoryId === id && sale.id !== excludeSaleId)
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

function aggregateYear(year) {
  const sales = state.sales.filter((sale) => yearFromDateString(sale.saleDate) === Number(year));
  const expenses = state.expenses.filter((expense) => yearFromDateString(expense.date) === Number(year));

  let salesTotal = 0;
  let cogsTotal = 0;
  let grossTotal = 0;
  let itemExpenseTotal = 0;
  const profitMap = [];

  sales.forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const derived = calcSaleDerived(sale, inv);
    salesTotal += derived.netAmount;
    cogsTotal += derived.cogs;
    grossTotal += derived.grossProfit;
    itemExpenseTotal += derived.itemExpense;
    profitMap.push({
      name: inv?.name || '不明商品',
      profit: derived.realProfit,
      date: sale.saleDate,
      platform: sale.platform || ''
    });
  });

  const commonExpense = expenses.reduce((sum, expense) => sum + safeNum(expense.amount), 0);
  const netProfit = grossTotal - itemExpenseTotal - commonExpense;
  const margin = salesTotal > 0 ? netProfit / salesTotal : 0;

  return {
    salesTotal, cogsTotal, grossTotal, itemExpenseTotal, commonExpense, netProfit, margin,
    profitMap: profitMap.sort((a, b) => b.profit - a.profit).slice(0, 10), salesCount: sales.length, expenseCount: expenses.length
  };
}

function monthlyRows(year) {
  const rows = [];
  for (let m = 1; m <= 12; m += 1) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const sales = state.sales.filter((sale) => monthKeyFromDateString(sale.saleDate) === key);
    const expenses = state.expenses.filter((expense) => monthKeyFromDateString(expense.date) === key);

    let salesTotal = 0;
    let cogs = 0;
    let itemExpenses = 0;
    let realProfitTotal = 0;
    sales.forEach((sale) => {
      const inv = inventoryItemById(sale.inventoryId);
      const derived = calcSaleDerived(sale, inv);
      salesTotal += derived.netAmount;
      cogs += derived.cogs;
      itemExpenses += derived.itemExpense;
      realProfitTotal += derived.realProfit;
    });

    const commonExpense = expenses.reduce((sum, expense) => sum + safeNum(expense.amount), 0);
    rows.push({
      month: `${m}月`, sales: salesTotal, cogs, gross: salesTotal - cogs,
      itemExpenses, commonExpense, net: realProfitTotal - commonExpense, count: sales.length
    });
  }
  return rows;
}

function duplicateCandidates() {
  const map = new Map();
  state.inventory.forEach((item) => {
    const key = `${(item.name || '').trim().toLowerCase()}|${(item.brand || '').trim().toLowerCase()}|${item.purchaseDate || ''}`;
    if (!item.name) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return [...map.values()].filter((rows) => rows.length > 1);
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

  duplicateCandidates().forEach((rows) => {
    issues.push({
      type: 'inventory',
      id: rows[0].id,
      title: rows[0].name || '重複候補',
      detail: `重複候補 ${rows.length}件 / ${rows.map((r) => r.brand || '-').join(', ')}`
    });
  });
  return issues;
}

function switchView(name) {
  state.currentView = name;
  views.forEach((viewName) => {
    qs(`#${viewName}View`)?.classList.toggle('active', viewName === name);
    qsa(`.tab[data-nav="${viewName}"]`).forEach((el) => el.classList.toggle('active', viewName === name));
  });
}

function serializeForm(form) {
  const obj = Object.fromEntries(new FormData(form).entries());
  return obj;
}

function saveDraft(key, payload) {
  localStorage.setItem(key, JSON.stringify(payload));
}
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
  renderSalePreview();
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

function applyValuesToForm(form, data) {
  Object.entries(data || {}).forEach(([key, value]) => {
    if (form[key] && typeof value !== 'object') form[key].value = value ?? '';
  });
}

function fillInventoryForm(item) {
  const form = qs('#inventoryForm');
  applyValuesToForm(form, item);
  state.pendingInventoryPhoto = item.photoDataUrl || null;
  setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', state.pendingInventoryPhoto);
  qs('#inventoryEditingBadge').classList.remove('hidden');
  switchView('inventory');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fillSaleForm(sale) {
  const form = qs('#saleForm');
  applyValuesToForm(form, sale);
  state.pendingSaleProof = sale.proofImageDataUrl || null;
  setImagePreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
  qs('#saleEditingBadge').classList.remove('hidden');
  renderSaleOptions(sale.inventoryId);
  renderSalePreview();
  switchView('sale');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fillExpenseForm(expense) {
  const form = qs('#expenseForm');
  applyValuesToForm(form, expense);
  qs('#expenseEditingBadge').classList.remove('hidden');
  switchView('expense');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderHome() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const inStock = state.inventory.filter((item) => currentQtyForInventory(item) > 0 && item.status !== '販売済').length;
  const monthlySales = state.sales.filter((sale) => monthKeyFromDateString(sale.saleDate) === ym);

  let monthlyRevenue = 0;
  let monthlyProfit = 0;
  monthlySales.forEach((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const derived = calcSaleDerived(sale, inv);
    monthlyRevenue += derived.netAmount;
    monthlyProfit += derived.realProfit;
  });

  const review = reviewItems();
  qs('#metricInStock').textContent = String(inStock);
  qs('#metricMonthlySales').textContent = yen(monthlyRevenue);
  qs('#metricMonthlyProfit').textContent = yen(monthlyProfit);
  qs('#metricReview').textContent = String(review.length);

  const recentSales = [...state.sales].sort((a, b) => new Date(b.saleDate) - new Date(a.saleDate)).slice(0, 5);
  qs('#homeRecentSales').innerHTML = recentSales.length
    ? recentSales.map((sale) => {
        const inv = inventoryItemById(sale.inventoryId);
        const derived = calcSaleDerived(sale, inv);
        return `
          <div class="list-item">
            <div class="row"><strong>${escapeHtml(inv?.name || '不明商品')}</strong><span class="badge ok">${escapeHtml(sale.platform || '販売')}</span></div>
            <div class="row"><span class="muted">${new Date(sale.saleDate).toLocaleDateString('ja-JP')}</span><strong>${yen(derived.netAmount)}</strong></div>
            <div class="row"><span class="muted">実利益</span><span>${yen(derived.realProfit)}</span></div>
          </div>`;
      }).join('')
    : '<div class="muted">販売データがまだありません。</div>';

  qs('#homeReviewList').innerHTML = review.length
    ? review.slice(0, 5).map((issue) => `<div class="list-item"><div class="row"><strong>${escapeHtml(issue.title)}</strong><span class="badge warn">要確認</span></div><div class="muted">${escapeHtml(issue.detail)}</div></div>`).join('')
    : '<div class="muted">要確認データはありません。</div>';
}

function inventoryCard(item) {
  const currentQty = currentQtyForInventory(item);
  const badgeClass = item.status === '販売済' ? 'ok' : item.status === '保留' ? 'warn' : '';
  const photo = item.photoDataUrl ? `<img class="photo-preview" src="${item.photoDataUrl}" alt="${escapeHtml(item.name)}">` : '';
  const carry = item.carryOverYear ? `<span class="badge">繰越 ${escapeHtml(item.carryOverYear)}</span>` : '';
  return `
    <div class="list-item">
      ${photo ? `<div class="row">${photo}</div>` : ''}
      <div class="row"><strong>${escapeHtml(item.name)}</strong><span class="badge ${badgeClass}">${escapeHtml(item.status || '在庫中')}</span></div>
      <div class="row"><span class="muted">${escapeHtml(item.brand || 'ブランド未入力')} / ${escapeHtml(item.category || 'カテゴリ未入力')}</span><span>${yen(item.purchasePrice || 0)}</span></div>
      <div class="row"><span class="muted">残数 ${currentQty}</span><span>${escapeHtml(item.purchaseDate || '-')}</span></div>
      <div class="row wrap">${carry}</div>
      <div class="row wrap">
        <button class="ghost edit-inventory" data-id="${item.id}">編集</button>
        <button class="ghost delete-inventory danger-btn" data-id="${item.id}">削除</button>
      </div>
    </div>`;
}

function renderInventory() {
  const search = (qs('#inventorySearch')?.value || '').trim().toLowerCase();
  const status = qs('#inventoryStatusFilter')?.value || '';
  const filtered = state.inventory
    .filter((item) => !search || `${item.name} ${item.brand} ${item.category} ${item.lotName || ''}`.toLowerCase().includes(search))
    .filter((item) => !status || item.status === status)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  qs('#inventoryList').innerHTML = filtered.length ? filtered.map(inventoryCard).join('') : '<div class="muted">在庫がまだありません。</div>';

  qsa('.edit-inventory').forEach((btn) => btn.onclick = () => {
    const item = inventoryItemById(btn.dataset.id);
    if (item) fillInventoryForm(item);
  });
  qsa('.delete-inventory').forEach((btn) => btn.onclick = () => {
    const item = inventoryItemById(btn.dataset.id);
    if (!item) return;
    openConfirm({
      title: '在庫を削除', message: `「${item.name}」を削除します。関連する販売履歴は残ります。`, okText: '削除',
      onOk: async () => {
        await remove('inventory', item.id);
        state.inventory = await getAll('inventory');
        refreshAll();
        toast('在庫を削除しました');
      }
    });
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

function salesCard(sale) {
  const inv = inventoryItemById(sale.inventoryId);
  const derived = calcSaleDerived(sale, inv);
  const proof = sale.proofImageDataUrl ? `<div class="row"><img class="photo-preview" src="${sale.proofImageDataUrl}" alt="販売証跡"></div>` : '';
  return `
    <div class="list-item">
      ${proof}
      <div class="row"><strong>${escapeHtml(inv?.name || '不明商品')}</strong><span class="badge ok">${escapeHtml(sale.platform || '')}</span></div>
      <div class="row"><span class="muted">${new Date(sale.saleDate).toLocaleString('ja-JP')}</span><strong>${yen(derived.netAmount)}</strong></div>
      <div class="row"><span class="muted">実利益 ${pct(derived.realMargin)}</span><span>${yen(derived.realProfit)}</span></div>
      <div class="row wrap">
        <button class="ghost edit-sale" data-id="${sale.id}">編集</button>
        <button class="ghost delete-sale danger-btn" data-id="${sale.id}">削除</button>
      </div>
    </div>`;
}

function renderSales() {
  renderSaleOptions(qs('#saleForm').inventoryId.value);
  const search = (qs('#salesSearch')?.value || '').trim().toLowerCase();
  const sales = [...state.sales].filter((sale) => {
    const inv = inventoryItemById(sale.inventoryId);
    const text = `${inv?.name || ''} ${sale.platform || ''} ${sale.externalItemId || ''}`.toLowerCase();
    return !search || text.includes(search);
  }).sort((a, b) => new Date(b.saleDate) - new Date(a.saleDate));

  qs('#salesList').innerHTML = sales.length ? sales.map(salesCard).join('') : '<div class="muted">販売履歴がまだありません。</div>';
  qsa('.edit-sale').forEach((btn) => btn.onclick = () => {
    const sale = state.sales.find((row) => row.id === btn.dataset.id);
    if (sale) fillSaleForm(sale);
  });
  qsa('.delete-sale').forEach((btn) => btn.onclick = () => {
    const sale = state.sales.find((row) => row.id === btn.dataset.id);
    const inv = inventoryItemById(sale?.inventoryId);
    if (!sale) return;
    openConfirm({
      title: '販売履歴を削除', message: `「${inv?.name || '販売データ'}」の販売履歴を削除します。`, okText: '削除',
      onOk: async () => {
        await remove('sales', sale.id);
        state.sales = await getAll('sales');
        await syncInventoryStatuses();
        refreshAll();
        toast('販売履歴を削除しました');
      }
    });
  });
}

function expenseCard(expense) {
  return `
    <div class="list-item">
      <div class="row"><strong>${escapeHtml(expense.title)}</strong><span class="badge">${escapeHtml(expense.category)}</span></div>
      <div class="row"><span class="muted">${escapeHtml(expense.date)}</span><strong>${yen(expense.amount)}</strong></div>
      <div class="row wrap">
        <button class="ghost edit-expense" data-id="${expense.id}">編集</button>
        <button class="ghost delete-expense danger-btn" data-id="${expense.id}">削除</button>
      </div>
    </div>`;
}

function renderExpenses() {
  const search = (qs('#expenseSearch')?.value || '').trim().toLowerCase();
  const expenses = [...state.expenses]
    .filter((expense) => !search || `${expense.title} ${expense.category}`.toLowerCase().includes(search))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  qs('#expenseList').innerHTML = expenses.length ? expenses.map(expenseCard).join('') : '<div class="muted">経費データがまだありません。</div>';

  qsa('.edit-expense').forEach((btn) => btn.onclick = () => {
    const expense = state.expenses.find((row) => row.id === btn.dataset.id);
    if (expense) fillExpenseForm(expense);
  });
  qsa('.delete-expense').forEach((btn) => btn.onclick = () => {
    const expense = state.expenses.find((row) => row.id === btn.dataset.id);
    if (!expense) return;
    openConfirm({
      title: '経費を削除', message: `「${expense.title}」を削除します。`, okText: '削除',
      onOk: async () => {
        await remove('expenses', expense.id);
        state.expenses = await getAll('expenses');
        refreshAll();
        toast('経費を削除しました');
      }
    });
  });
}

function renderMonthlyChart(rows) {
  const chart = qs('#monthlyChart');
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  chart.innerHTML = rows.map((row) => {
    const height = Math.max(6, Math.round((Math.abs(row.net) / max) * 120));
    const cls = row.net >= 0 ? 'bar positive' : 'bar negative';
    return `<div class="chart-col"><div class="chart-value">${yen(row.net)}</div><div class="${cls}" style="height:${height}px"></div><div class="chart-label">${row.month}</div></div>`;
  }).join('');
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

  qs('#sumSales').textContent = yen(agg.salesTotal);
  qs('#sumCOGS').textContent = yen(agg.cogsTotal);
  qs('#sumGross').textContent = yen(agg.grossTotal);
  qs('#sumExpense').textContent = yen(agg.commonExpense + agg.itemExpenseTotal);
  qs('#sumNet').textContent = yen(agg.netProfit);
  qs('#sumMargin').textContent = pct(agg.margin);

  const monthly = monthlyRows(year);
  renderMonthlyChart(monthly);
  qs('#monthlySummary').innerHTML = `
    <table>
      <thead><tr><th>月</th><th>売上</th><th>原価</th><th>粗利</th><th>商品別経費</th><th>共通経費</th><th>実利益</th><th>件数</th></tr></thead>
      <tbody>${monthly.map((row) => `
        <tr>
          <td>${row.month}</td>
          <td>${yen(row.sales)}</td>
          <td>${yen(row.cogs)}</td>
          <td>${yen(row.gross)}</td>
          <td>${yen(row.itemExpenses)}</td>
          <td>${yen(row.commonExpense)}</td>
          <td>${yen(row.net)}</td>
          <td>${row.count}</td>
        </tr>`).join('')}</tbody>
    </table>`;

  qs('#topProfitList').innerHTML = agg.profitMap.length
    ? agg.profitMap.map((item) => `<div class="list-item"><div class="row"><strong>${escapeHtml(item.name)}</strong><strong>${yen(item.profit)}</strong></div><div class="row"><span class="muted">${new Date(item.date).toLocaleDateString('ja-JP')}</span><span>${escapeHtml(item.platform)}</span></div></div>`).join('')
    : '<div class="muted">まだ利益上位データがありません。</div>';

  const carryCount = state.inventory.filter((item) => Number(item.carryOverYear) === year).length;
  qs('#summaryBreakdown').innerHTML = `
    <div class="list-item"><div class="row"><span class="muted">売上件数</span><strong>${agg.salesCount}件</strong></div></div>
    <div class="list-item"><div class="row"><span class="muted">経費件数</span><strong>${agg.expenseCount}件</strong></div></div>
    <div class="list-item"><div class="row"><span class="muted">商品別追加経費</span><strong>${yen(agg.itemExpenseTotal)}</strong></div></div>
    <div class="list-item"><div class="row"><span class="muted">共通経費</span><strong>${yen(agg.commonExpense)}</strong></div></div>
    <div class="list-item"><div class="row"><span class="muted">前年繰越在庫件数</span><strong>${carryCount}件</strong></div></div>`;
}

function renderReview() {
  const issues = reviewItems();
  qs('#reviewList').innerHTML = issues.length ? issues.map((issue) => `
      <div class="list-item">
        <div class="row"><strong>${escapeHtml(issue.title)}</strong><span class="badge warn">${issue.type === 'inventory' ? '在庫' : '販売'}</span></div>
        <div class="muted">${escapeHtml(issue.detail)}</div>
        <div class="row wrap"><button class="ghost review-jump" data-type="${issue.type}" data-id="${issue.id}">開く</button></div>
      </div>`).join('') : '<div class="muted">要確認データはありません。</div>';

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

function renderSalePreview() {
  const form = qs('#saleForm');
  const inv = inventoryItemById(form.inventoryId.value);
  const draft = Object.fromEntries(new FormData(form).entries());
  const derived = calcSaleDerived(draft, inv);
  qs('#salePreviewCogs').textContent = yen(derived.cogs);
  qs('#salePreviewGross').textContent = yen(derived.grossProfit);
  qs('#salePreviewReal').textContent = yen(derived.realProfit);
  qs('#salePreviewMargin').textContent = pct(derived.realMargin);
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
    const inv = inventoryItemById(sale.inventoryId);
    const derived = calcSaleDerived(sale, inv);
    rows.push([sale.saleDate, '売上', inv?.name || '', sale.platform || '', derived.saleQty, derived.netAmount, derived.cogs, derived.itemExpense, '', derived.realProfit, sale.note || '']);
  });
  [...state.expenses].sort((a, b) => new Date(a.date) - new Date(b.date)).forEach((expense) => {
    rows.push([expense.date, '共通経費', '', expense.title, '', '', '', '', expense.amount, -safeNum(expense.amount), expense.memo || '']);
  });
  return rows;
}

function downloadLedgerCsv() {
  downloadBlob(`ledger-${todayDate()}.csv`, toCSV(buildLedgerRows()), 'text/csv;charset=utf-8');
  toast('帳簿CSVを書き出しました');
}

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

function downloadStoreCsv(storeName, filename) {
  downloadBlob(filename, toCSV(buildStoreCsvRows(storeName)), 'text/csv;charset=utf-8');
  toast('CSVを書き出しました');
}

async function refreshAll() {
  renderHome(); renderInventory(); renderSales(); renderExpenses(); renderSummary(); renderReview(); renderCarryoverPreview();
}
async function loadState() {
  state.inventory = await getAll('inventory');
  state.sales = await getAll('sales');
  state.expenses = await getAll('expenses');
}

function bindNav() { qsa('[data-nav]').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.nav))); }
function registerSW() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {}); }

function bindInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    qs('#installBtn').classList.remove('hidden');
  });
  qs('#installBtn').onclick = async () => {
    if (!state.deferredPrompt) return;
    await state.deferredPrompt.prompt();
    state.deferredPrompt = null;
    qs('#installBtn').classList.add('hidden');
  };
}

function exportBackup() {
  exportAll().then((payload) => {
    downloadBlob(`noirstock-backup-${todayDate()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    toast('JSONバックアップを書き出しました');
  });
}

async function importBackup(file) {
  const text = await file.text();
  const data = normalizeImportData(JSON.parse(text));
  await bulkReplace(data);
  await loadState();
  refreshAll();
  toast('バックアップを復元しました');
}


function normalizeImportData(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    inventory: Array.isArray(data.inventory) ? data.inventory : [],
    sales: Array.isArray(data.sales) ? data.sales : [],
    expenses: Array.isArray(data.expenses) ? data.expenses : [],
    settings: Array.isArray(data.settings) ? data.settings : []
  };
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
  const wrap = qs('#migrationPreview');
  const data = state.migrationData?.data;
  if (!data) {
    wrap.innerHTML = '<div class="muted">移行用JSONを選ぶと、件数と対象年をここに表示します。</div>';
    return;
  }
  const yearLabel = inferYearRange(data);
  wrap.innerHTML = `
    <div class="list-item">
      <div class="row"><strong>${escapeHtml(state.migrationData.fileName || '移行JSON')}</strong><span class="badge">${yearLabel}</span></div>
      <div class="muted">在庫 ${data.inventory.length}件 / 販売 ${data.sales.length}件 / 経費 ${data.expenses.length}件</div>
    </div>
    <div class="muted">置換は現在データをすべて入れ替えます。追加は現在データを残したまま、ID衝突を避けて取り込みます。</div>
  `;
}

function cloneWithUniqueId(row, prefix, usedIds, remap = null, refField = '') {
  const cloned = { ...row };
  const oldId = cloned.id || uid(prefix);
  let newId = oldId;
  while (usedIds.has(newId)) newId = uid(prefix);
  usedIds.add(newId);
  cloned.id = newId;
  if (remap) remap.set(oldId, newId);
  if (refField && cloned[refField] && remap?.has(cloned[refField])) cloned[refField] = remap.get(cloned[refField]);
  return cloned;
}

async function runMigrationImport(mode = 'replace') {
  const data = state.migrationData?.data;
  if (!data) { toast('先に移行JSONを選択してください'); return; }
  const normalized = normalizeImportData(data);
  if (mode === 'replace') {
    await bulkReplace(normalized);
  } else {
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
    await bulkReplace({
      inventory: [...(current.inventory || []), ...importedInventory],
      sales: [...(current.sales || []), ...importedSales],
      expenses: [...(current.expenses || []), ...importedExpenses],
      settings: current.settings || []
    });
  }
  state.migrationData = null;
  qs('#migrationInput').value = '';
  await loadState();
  await refreshAll();
  renderMigrationPreview();
  toast(mode === 'replace' ? '移行データを取り込みました' : '移行データを追加取り込みしました');
}

function buildCarryoverPreview(data, sourceYear, targetYear) {
  const prevInventory = data.inventory || [];
  const prevSales = data.sales || [];
  const year = Number(sourceYear);
  const saleQtyById = new Map();
  prevSales.filter((sale) => yearFromDateString(sale.saleDate) <= year).forEach((sale) => {
    saleQtyById.set(sale.inventoryId, (saleQtyById.get(sale.inventoryId) || 0) + Math.max(1, safeNum(sale.saleQty || 1)));
  });

  return prevInventory.map((item) => {
    const sold = saleQtyById.get(item.id) || 0;
    const remain = Math.max(0, safeNum(item.quantity || 1) - sold);
    return { source: item, remain };
  }).filter((row) => row.remain > 0 && yearFromDateString(row.source.purchaseDate) <= year);
}

function renderCarryoverPreview() {
  const wrap = qs('#carryoverPreview');
  const rows = state.carryoverData?.preview || [];
  wrap.innerHTML = rows.length
    ? rows.slice(0, 30).map((row) => `<div class="list-item"><div class="row"><strong>${escapeHtml(row.source.name || '無題')}</strong><span class="badge">残${row.remain}</span></div><div class="muted">${escapeHtml(row.source.brand || '')} / 仕入 ${yen(row.source.purchasePrice || 0)} / 元年 ${state.carryoverData.sourceYear} → 先年 ${state.carryoverData.targetYear}</div></div>`).join('') + (rows.length > 30 ? `<div class="muted">他 ${rows.length - 30} 件</div>` : '')
    : '<div class="muted">プレビューはまだありません。</div>';
}

async function runCarryover() {
  if (!state.carryoverData?.preview?.length) { toast('先にプレビューしてください'); return; }
  const { preview, sourceYear, targetYear } = state.carryoverData;
  for (const row of preview) {
    const source = row.source;
    const cloned = {
      ...source,
      id: uid('inv'),
      createdAt: new Date().toISOString(),
      purchaseDate: `${targetYear}-01-01`,
      quantity: row.remain,
      status: '在庫中',
      carryOverYear: String(sourceYear),
      memo: `${source.memo || ''}\n[前年繰越] ${sourceYear}年末残在庫より作成`.trim()
    };
    await put('inventory', cloned);
  }
  await loadState();
  refreshAll();
  toast(`前年繰越 ${preview.length}件を作成しました`);
}

function bindForms() {
  qs('#inventoryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    const item = { ...payload, id: payload.id || uid('inv'), createdAt: payload.createdAt || new Date().toISOString(), quantity: Math.max(1, safeNum(payload.quantity || 1)), purchasePrice: safeNum(payload.purchasePrice), plannedPrice: safeNum(payload.plannedPrice), photoDataUrl: state.pendingInventoryPhoto || '' };
    await put('inventory', item);
    state.inventory = await getAll('inventory');
    clearDraft(DRAFT_KEYS.inventory);
    resetInventoryForm();
    refreshAll();
    toast('在庫を保存しました');
  });

  qs('#saleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    const inv = inventoryItemById(payload.inventoryId);
    if (!inv) return toast('対象商品を選択してください');
    const saleQty = Math.max(1, safeNum(payload.saleQty || 1));
    const remain = currentQtyForInventory(inv, payload.id);
    if (saleQty > remain) return toast(`販売数量が在庫残数(${remain})を超えています`);
    const sale = { ...payload, id: payload.id || uid('sale'), createdAt: payload.createdAt || new Date().toISOString(), saleQty, salePrice: safeNum(payload.salePrice), platformFee: safeNum(payload.platformFee), shippingFee: safeNum(payload.shippingFee), itemExpense: safeNum(payload.itemExpense), netAmount: payload.netAmount === '' ? '' : safeNum(payload.netAmount), proofImageDataUrl: state.pendingSaleProof || '' };
    await put('sales', sale);
    state.sales = await getAll('sales');
    await syncInventoryStatuses();
    clearDraft(DRAFT_KEYS.sale);
    resetSaleForm();
    refreshAll();
    toast('販売結果を保存しました');
  });

  qs('#expenseForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    const expense = { ...payload, id: payload.id || uid('exp'), createdAt: payload.createdAt || new Date().toISOString(), amount: safeNum(payload.amount) };
    await put('expenses', expense);
    state.expenses = await getAll('expenses');
    clearDraft(DRAFT_KEYS.expense);
    resetExpenseForm();
    refreshAll();
    toast('経費を保存しました');
  });
}

function bindButtons() {
  qs('#homeExportBtn').onclick = downloadLedgerCsv;
  qs('#quickBackupBtn').onclick = exportBackup;
  qs('#backupBtn').onclick = exportBackup;
  qs('#inventoryCsvBtn').onclick = () => downloadStoreCsv('inventory', `inventory-${todayDate()}.csv`);
  qs('#salesCsvBtn').onclick = () => downloadStoreCsv('sales', `sales-${todayDate()}.csv`);
  qs('#expensesCsvBtn').onclick = () => downloadStoreCsv('expenses', `expenses-${todayDate()}.csv`);
  qs('#ledgerCsvBtn').onclick = downloadLedgerCsv;

  qs('#inventoryResetBtn').onclick = () => resetInventoryForm(true);
  qs('#saleResetBtn').onclick = () => { resetSaleForm(true); renderSaleOptions(); };
  qs('#expenseResetBtn').onclick = () => resetExpenseForm(true);

  qs('#parseSaleTextBtn').onclick = () => {
    const parsed = parseMercariText(qs('#saleParseText').value || '');
    applyValuesToForm(qs('#saleForm'), parsed);
    renderSalePreview();
    saveDraft(DRAFT_KEYS.sale, { ...serializeForm(qs('#saleForm')), saleParseText: qs('#saleParseText').value, pendingSaleProof: state.pendingSaleProof || '' });
    toast('テキスト解析を反映しました');
  };

  qs('#fillNetAmountBtn').onclick = () => {
    const form = qs('#saleForm');
    const salePrice = safeNum(form.salePrice.value);
    const fee = safeNum(form.platformFee.value);
    const shipping = safeNum(form.shippingFee.value);
    form.netAmount.value = Math.max(0, salePrice - fee - shipping);
    renderSalePreview();
  };

  qs('#removeInventoryPhotoBtn').onclick = () => {
    state.pendingInventoryPhoto = null;
    setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', null);
    saveDraft(DRAFT_KEYS.inventory, { ...serializeForm(qs('#inventoryForm')), pendingInventoryPhoto: '' });
  };
  qs('#removeSaleProofBtn').onclick = () => {
    state.pendingSaleProof = null;
    setImagePreview('#saleProofPreview', '#removeSaleProofBtn', null);
    saveDraft(DRAFT_KEYS.sale, { ...serializeForm(qs('#saleForm')), saleParseText: qs('#saleParseText').value, pendingSaleProof: '' });
  };

  qs('#inventoryPhotoInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    state.pendingInventoryPhoto = await fileToDataUrl(file);
    setImagePreview('#inventoryPhotoPreview', '#removeInventoryPhotoBtn', state.pendingInventoryPhoto);
    saveDraft(DRAFT_KEYS.inventory, { ...serializeForm(qs('#inventoryForm')), pendingInventoryPhoto: state.pendingInventoryPhoto });
  });
  qs('#saleProofInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    state.pendingSaleProof = await fileToDataUrl(file);
    setImagePreview('#saleProofPreview', '#removeSaleProofBtn', state.pendingSaleProof);
    saveDraft(DRAFT_KEYS.sale, { ...serializeForm(qs('#saleForm')), saleParseText: qs('#saleParseText').value, pendingSaleProof: state.pendingSaleProof });
  });

  qs('#restoreInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    openConfirm({ title: 'バックアップを復元', message: '現在のデータを置き換えます。続けますか？', okText: '復元', onOk: () => importBackup(file) });
  });
  qs('#migrationInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const text = await file.text();
      state.migrationData = { fileName: file.name, data: normalizeImportData(JSON.parse(text)) };
      renderMigrationPreview();
      toast('移行JSONを読み込みました');
    } catch (error) {
      console.error(error);
      toast('移行JSONの読み込みに失敗しました');
    }
  });
  qs('#migrationReplaceBtn').onclick = () => openConfirm({ title: '移行データで置換', message: '現在の在庫・販売・経費データを置き換えます。続けますか？', okText: '置換', onOk: () => runMigrationImport('replace') });
  qs('#migrationMergeBtn').onclick = () => openConfirm({ title: '移行データを追加', message: '現在のデータを残したまま追加します。重複しそうなIDは自動で調整します。', okText: '追加', onOk: () => runMigrationImport('merge') });

  qs('#summaryYearSelect').addEventListener('change', renderSummary);
  qs('#saleForm').addEventListener('input', renderSalePreview);
  qs('#saleForm').addEventListener('change', renderSalePreview);
  qs('#saleInventorySelect').addEventListener('change', renderSalePreview);
  qs('#inventorySearch').addEventListener('input', renderInventory);
  qs('#inventoryStatusFilter').addEventListener('change', renderInventory);
  qs('#salesSearch').addEventListener('input', renderSales);
  qs('#expenseSearch').addEventListener('input', renderExpenses);

  qs('#carryoverPreviewBtn').onclick = async () => {
    const file = qs('#carryoverBackupInput').files?.[0];
    const sourceYear = qs('#carryoverSourceYear').value;
    const targetYear = qs('#carryoverTargetYear').value;
    if (!file || !sourceYear || !targetYear) return toast('バックアップ・元年・繰越先年を選択してください');
    const text = await file.text();
    const data = JSON.parse(text);
    state.carryoverData = { raw: data, sourceYear, targetYear, preview: buildCarryoverPreview(data, sourceYear, targetYear) };
    renderCarryoverPreview();
    toast(`プレビュー ${state.carryoverData.preview.length}件`);
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
  renderMigrationPreview();
  await syncInventoryStatuses();
  await refreshAll();
}

boot().catch((error) => {
  console.error(error);
  toast('起動中にエラーが発生しました');
});
