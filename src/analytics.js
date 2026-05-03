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
