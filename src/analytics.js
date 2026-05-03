import { saleProfit } from './calc.js';
import { num } from './utils.js';

function daysBetween(a, b) {
  if (!a || !b) return null;
  const d1 = new Date(a), d2 = new Date(b);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

export function channelStats(data, year = null) {
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  const channelById = Object.fromEntries(data.salesChannels.map(c => [c.id, c]));
  const rows = {};
  for (const sale of data.sales) {
    if (year && String(sale.soldAt || '').slice(0, 4) !== String(year)) continue;
    const channelId = sale.channelId || 'unknown';
    const channel = channelById[channelId];
    const key = channelId;
    rows[key] ||= {
      channelId,
      name: channel?.name || '未設定',
      type: channel?.type || 'unknown',
      sales: 0,
      count: 0,
      profit: 0,
      fee: 0,
      shipping: 0
    };
    const calc = saleProfit(sale, invById[sale.inventoryId]);
    rows[key].sales += calc.gross;
    rows[key].profit += calc.profit;
    rows[key].fee += calc.fee;
    rows[key].shipping += calc.shipping;
    rows[key].count += 1;
  }
  return Object.values(rows).map(r => ({ ...r, margin: r.sales ? r.profit / r.sales * 100 : 0 })).sort((a, b) => b.profit - a.profit);
}

export function eventStats(data, year = null) {
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  return data.events.filter(ev => !year || String(ev.eventDate || '').slice(0, 4) === String(year)).map(ev => {
    const sales = data.sales.filter(s => s.eventId === ev.id);
    const gross = sales.reduce((sum, s) => sum + saleProfit(s, invById[s.inventoryId]).gross, 0);
    const saleProfitTotal = sales.reduce((sum, s) => sum + saleProfit(s, invById[s.inventoryId]).profit, 0);
    const eventCost = num(ev.boothFee) + num(ev.transportCost) + num(ev.otherCost);
    const net = saleProfitTotal - eventCost;
    return {
      eventId: ev.id,
      name: ev.eventName,
      date: ev.eventDate,
      gross,
      count: sales.length,
      saleProfit: saleProfitTotal,
      eventCost,
      net
    };
  }).sort((a, b) => b.net - a.net);
}

export function staleListings(data, today = new Date()) {
  const now = today.toISOString().slice(0, 10);
  return data.listingRecords.filter(l => l.status === 'listed').map(l => {
    const inv = data.inventories.find(i => i.id === l.inventoryId);
    const ch = data.salesChannels.find(c => c.id === l.channelId);
    return {
      ...l,
      itemName: inv?.name || '不明商品',
      channelName: ch?.name || '未設定',
      days: daysBetween(l.listedAt, now)
    };
  }).sort((a, b) => (b.days || 0) - (a.days || 0));
}

export function listingLeadTimeStats(data) {
  const rows = [];
  for (const l of data.listingRecords) {
    if (!l.soldSaleId) continue;
    const sale = data.sales.find(s => s.id === l.soldSaleId);
    const inv = data.inventories.find(i => i.id === l.inventoryId);
    const days = daysBetween(l.listedAt, sale?.soldAt);
    if (days !== null) rows.push({ listingId: l.id, inventoryId: l.inventoryId, itemName: inv?.name || '', days });
  }
  const avg = rows.length ? rows.reduce((s, r) => s + r.days, 0) / rows.length : 0;
  return { rows, avg, count: rows.length };
}


export function priceRangeStats(data, year = null) {
  const ranges = [
    { label: '〜999円', min: 0, max: 999 },
    { label: '1,000〜1,999円', min: 1000, max: 1999 },
    { label: '2,000〜2,999円', min: 2000, max: 2999 },
    { label: '3,000〜4,999円', min: 3000, max: 4999 },
    { label: '5,000円〜', min: 5000, max: Infinity }
  ].map(r => ({ ...r, count: 0, sales: 0, profit: 0 }));
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  for (const sale of data.sales) {
    if (year && String(sale.soldAt || '').slice(0, 4) !== String(year)) continue;
    const price = num(sale.grossPrice);
    const range = ranges.find(r => price >= r.min && price <= r.max);
    if (!range) continue;
    const calc = saleProfit(sale, invById[sale.inventoryId]);
    range.count += 1;
    range.sales += calc.gross;
    range.profit += calc.profit;
  }
  return ranges;
}

export function categoryStats(data, year = null) {
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  const rows = {};
  for (const sale of data.sales) {
    if (year && String(sale.soldAt || '').slice(0, 4) !== String(year)) continue;
    const inv = invById[sale.inventoryId];
    const key = inv?.productCategory || inv?.handmadeLine || inv?.productType || '未分類';
    rows[key] ||= { category: key, count: 0, sales: 0, profit: 0 };
    const calc = saleProfit(sale, inv);
    rows[key].count += 1;
    rows[key].sales += calc.gross;
    rows[key].profit += calc.profit;
  }
  return Object.values(rows).map(r => ({ ...r, margin: r.sales ? r.profit / r.sales * 100 : 0 })).sort((a, b) => b.profit - a.profit);
}


export function monthlyTrendStats(data, year = new Date().getFullYear()) {
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  const rows = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: `${i + 1}月`,
    sales: 0,
    profit: 0,
    count: 0,
    cost: 0,
    fee: 0,
    shipping: 0
  }));
  for (const sale of data.sales) {
    if (String(sale.soldAt || '').slice(0, 4) !== String(year)) continue;
    const m = Number(String(sale.soldAt || '').slice(5, 7));
    if (!m || !rows[m - 1]) continue;
    const calc = saleProfit(sale, invById[sale.inventoryId]);
    rows[m - 1].sales += calc.gross;
    rows[m - 1].profit += calc.profit;
    rows[m - 1].cost += calc.cost;
    rows[m - 1].fee += calc.fee;
    rows[m - 1].shipping += calc.shipping;
    rows[m - 1].count += 1;
  }
  return rows;
}

export function topProductsByProfit(data, year = null, limit = 8) {
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  const rows = {};
  for (const sale of data.sales) {
    if (year && String(sale.soldAt || '').slice(0, 4) !== String(year)) continue;
    const inv = invById[sale.inventoryId];
    const key = sale.inventoryId || sale.id;
    rows[key] ||= {
      inventoryId: sale.inventoryId,
      name: inv?.name || sale.memo || '不明商品',
      productType: inv?.productType || 'unknown',
      count: 0,
      sales: 0,
      profit: 0
    };
    const calc = saleProfit(sale, inv);
    rows[key].count += 1;
    rows[key].sales += calc.gross;
    rows[key].profit += calc.profit;
  }
  return Object.values(rows).sort((a, b) => b.profit - a.profit).slice(0, limit);
}

export function handmadeOnlyStats(data, year = null) {
  const invById = Object.fromEntries(data.inventories.map(i => [i.id, i]));
  const sales = data.sales.filter(s => {
    if (year && String(s.soldAt || '').slice(0, 4) !== String(year)) return false;
    return invById[s.inventoryId]?.productType === 'handmade';
  });
  const salesTotal = sales.reduce((sum, s) => sum + saleProfit(s, invById[s.inventoryId]).gross, 0);
  const profit = sales.reduce((sum, s) => sum + saleProfit(s, invById[s.inventoryId]).profit, 0);
  return {
    count: sales.length,
    salesTotal,
    profit,
    margin: salesTotal ? profit / salesTotal * 100 : 0
  };
}
