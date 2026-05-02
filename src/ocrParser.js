import { safeNum } from './utils.js';
import { createOcrCandidate } from './ocrModel.js';

const FIELD_LABELS = {
  salePrice: '販売単価',
  platformFee: '販売手数料',
  shippingFee: '送料',
  netAmount: '販売利益/受取額',
  saleDate: '販売日',
  externalItemId: '商品ID',
  platform: '販売先',
  shippingMethod: '配送方法',
};

export function normalizeOcrText(text = '') {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[，、]/g, ',')
    .replace(/[￥]/g, '¥')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function make(field, value, confidence, source = 'parser') {
  if (value === undefined || value === null || value === '') return null;
  return createOcrCandidate(field, FIELD_LABELS[field] || field, value, confidence, source);
}

function moneyCandidatesNearLabels(text, labels, field) {
  const candidates = [];
  labels.forEach((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reg = new RegExp(`${escaped}[^¥0-9]{0,20}¥?\\s*([0-9][0-9,]*)`, 'ig');
    let m;
    while ((m = reg.exec(text))) {
      const value = safeNum(m[1]);
      if (value || value === 0) candidates.push(make(field, value, 0.9, `label:${label}`));
    }
  });
  return candidates.filter(Boolean);
}

function firstCandidate(candidates, field, fallbackLabels = []) {
  if (candidates.length) return candidates[0];
  return null;
}

function extractDateCandidates(text) {
  const out = [];
  const jp = /((20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?)/g;
  let m;
  while ((m = jp.exec(text))) {
    const [, , y, mo, d, h = '00', mi = '00'] = m;
    out.push(make('saleDate', `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mi}`, 0.82, 'date:jp'));
  }
  const iso = /((20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?)/g;
  while ((m = iso.exec(text))) {
    const [, , y, mo, d, h = '00', mi = '00'] = m;
    out.push(make('saleDate', `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mi}`, 0.78, 'date:iso'));
  }
  return out.filter(Boolean);
}

function extractItemId(text) {
  const m = text.match(/(?:商品ID|商品番号|ID)\s*[:：]?\s*([a-zA-Z]\d{8,})/i) || text.match(/\b([a-zA-Z]\d{8,})\b/);
  return m ? make('externalItemId', m[1], 0.84, 'id') : null;
}

function extractPlatform(text) {
  if (/メルカリ|mercari/i.test(text)) return make('platform', 'メルカリ', 0.95, 'platform');
  if (/ラクマ|rakuma/i.test(text)) return make('platform', 'ラクマ', 0.92, 'platform');
  if (/ヤフオク|Yahoo/i.test(text)) return make('platform', 'ヤフオク', 0.92, 'platform');
  return null;
}

function extractShippingMethod(text) {
  const m = text.match(/(ゆうゆうメルカリ便|らくらくメルカリ便|普通郵便|クリックポスト|レターパック|宅急便コンパクト|ゆうパケット)/);
  return m ? make('shippingMethod', m[1], 0.78, 'shipping-method') : null;
}

export function parseSaleEvidenceText(rawText = '') {
  const text = normalizeOcrText(rawText);
  const warnings = [];
  const candidates = [];
  candidates.push(...moneyCandidatesNearLabels(text, ['商品代金', '販売価格', '商品価格', '売上'], 'salePrice'));
  candidates.push(...moneyCandidatesNearLabels(text, ['販売手数料', '手数料'], 'platformFee'));
  candidates.push(...moneyCandidatesNearLabels(text, ['配送料', '送料', '配送\s*料'], 'shippingFee'));
  candidates.push(...moneyCandidatesNearLabels(text, ['販売利益', '受取額', '受取金額', '利益'], 'netAmount'));
  candidates.push(...extractDateCandidates(text));
  const id = extractItemId(text); if (id) candidates.push(id);
  const platform = extractPlatform(text); if (platform) candidates.push(platform);
  const shippingMethod = extractShippingMethod(text); if (shippingMethod) candidates.push(shippingMethod);

  const byField = {};
  candidates.forEach((c) => {
    if (!c) return;
    if (!byField[c.field] || c.confidence > byField[c.field].confidence) byField[c.field] = c;
  });

  if (byField.salePrice && byField.platformFee && byField.shippingFee && byField.netAmount) {
    const calcNet = safeNum(byField.salePrice.value) - safeNum(byField.platformFee.value) - safeNum(byField.shippingFee.value);
    const diff = Math.abs(calcNet - safeNum(byField.netAmount.value));
    if (diff > 100) warnings.push(`OCRの販売利益候補と計算値に差があります: 差額 ${diff}円`);
  }
  if (!byField.salePrice) warnings.push('販売単価候補が見つかりませんでした。');
  if (!byField.platformFee) warnings.push('販売手数料候補が見つかりませんでした。');
  if (!byField.shippingFee) warnings.push('送料候補が見つかりませんでした。');

  const result = {
    salePrice: byField.salePrice?.value ?? null,
    platformFee: byField.platformFee?.value ?? null,
    shippingFee: byField.shippingFee?.value ?? null,
    netAmount: byField.netAmount?.value ?? null,
    saleDate: byField.saleDate?.value ?? '',
    externalItemId: byField.externalItemId?.value ?? '',
    platform: byField.platform?.value ?? '',
    shippingMethod: byField.shippingMethod?.value ?? '',
    _rawText: text,
    _candidates: candidates.filter(Boolean),
    _warnings: warnings,
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null && value !== undefined));
}
