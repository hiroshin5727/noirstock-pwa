export const yen = (value) => new Intl.NumberFormat('ja-JP', {
  style: 'currency', currency: 'JPY', maximumFractionDigits: 0
}).format(Number(value || 0));

export const pct = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '-';
export const uid = (prefix = 'id') => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
export const safeNum = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const cleaned = typeof value === 'string' ? value.replace(/[¥￥,\s]/g, '') : value;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
export const todayDate = () => new Date().toISOString().slice(0, 10);
export const nowLocalDateTime = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
export const escapeHtml = (s = '') => String(s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

export function monthKeyFromDateString(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function yearFromDateString(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear();
}

export function downloadBlob(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function toCSV(rows) {
  return rows.map((row) => row.map((val) => {
    const text = String(val ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n');
}

export function parseMercariText(text = '') {
  const result = {};
  const clean = String(text).replace(/\u00a0/g, ' ').replace(/,/g, '');
  const money = (label) => {
    const match = clean.match(new RegExp(`${label}\\s*¥?([0-9]+)`, 'i'));
    return match ? Number(match[1]) : null;
  };

  result.salePrice = money('商品代金');
  result.platformFee = money('販売手数料');
  result.shippingFee = money('配送料|配送料|送料');
  result.netAmount = money('販売利益|受取額');

  const itemId = clean.match(/商品ID\s*([a-z]\d{8,})/i);
  if (itemId) result.externalItemId = itemId[1];

  const date = clean.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (date) {
    const [, y, m, d, h, min] = date;
    result.saleDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${min}`;
  }

  if (/メルカリ/i.test(clean)) result.platform = 'メルカリ';
  if (/ラクマ/i.test(clean)) result.platform = 'ラクマ';
  if (/ヤフオク/i.test(clean)) result.platform = 'ヤフオク';

  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null && value !== ''));
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
