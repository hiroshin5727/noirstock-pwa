import { uid } from './utils.js';

export const OCR_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  PARSED: 'parsed',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
};

export function createOcrCandidate(field, label, value, confidence = 0.5, source = 'parser') {
  return {
    id: uid('cand'),
    field,
    label,
    value,
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0.5,
    source,
    createdAt: new Date().toISOString(),
  };
}

export function createEmptyOcrRecord(partial = {}) {
  return {
    id: partial.id || uid('ocr'),
    createdAt: partial.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: normalizeOcrStatus(partial.status || OCR_STATUS.PENDING),
    sourceType: partial.sourceType || 'saleEvidence',
    imageId: partial.imageId || '',
    imageDataUrl: partial.imageDataUrl || '',
    imageMeta: partial.imageMeta || {},
    rawText: partial.rawText || '',
    engine: partial.engine || '',
    candidates: normalizeCandidates(partial.candidates),
    acceptedFields: partial.acceptedFields || {},
    linkedInventoryId: partial.linkedInventoryId || '',
    linkedSaleId: partial.linkedSaleId || '',
    note: partial.note || '',
    warnings: Array.isArray(partial.warnings) ? partial.warnings : [],
  };
}

export function normalizeOcrStatus(status = '') {
  const s = String(status || '').trim();
  if (['未確定', 'pending'].includes(s)) return OCR_STATUS.PENDING;
  if (['解析中', 'processing'].includes(s)) return OCR_STATUS.PROCESSING;
  if (['候補あり', 'parsed'].includes(s)) return OCR_STATUS.PARSED;
  if (['確定', 'confirmed'].includes(s)) return OCR_STATUS.CONFIRMED;
  if (['失敗', 'failed'].includes(s)) return OCR_STATUS.FAILED;
  return s || OCR_STATUS.PENDING;
}

export function normalizeCandidates(value) {
  if (Array.isArray(value)) {
    return value.map((row) => ({
      id: row.id || uid('cand'),
      field: row.field || row.key || '',
      label: row.label || row.field || row.key || '候補',
      value: row.value ?? '',
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.5,
      source: row.source || 'parser',
      createdAt: row.createdAt || new Date().toISOString(),
    }));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([field, rows]) => {
      const list = Array.isArray(rows) ? rows : [rows];
      return list.filter(Boolean).map((row) => typeof row === 'object'
        ? createOcrCandidate(field, row.label || field, row.value ?? row, row.confidence ?? 0.5, row.source || 'parser')
        : createOcrCandidate(field, field, row, 0.5, 'parser'));
    });
  }
  return [];
}

export function recordToParseResult(record = {}) {
  const result = { _ocrRecordId: record.id || '', _rawText: record.rawText || '', _engine: record.engine || '', _warnings: record.warnings || [] };
  normalizeCandidates(record.candidates).forEach((candidate) => {
    if (!candidate.field) return;
    if (result[candidate.field] === undefined || candidate.confidence > (result[`_${candidate.field}Confidence`] || 0)) {
      result[candidate.field] = candidate.value;
      result[`_${candidate.field}Confidence`] = candidate.confidence;
    }
  });
  return result;
}

export function applyAcceptedField(record, field, value) {
  return {
    ...record,
    acceptedFields: {
      ...(record.acceptedFields || {}),
      [field]: value,
    },
    status: OCR_STATUS.CONFIRMED,
    updatedAt: new Date().toISOString(),
  };
}

export function saleOcrStatus(sale = {}) {
  const status = normalizeOcrStatus(sale.ocrStatus || '');
  if (sale.ocrRecordId || status === OCR_STATUS.CONFIRMED || sale.ocrStatus === '確定') return '確定';
  if (sale.proofImageDataUrl && !sale.externalItemId) return '未確定';
  if (sale.proofImageDataUrl) return '候補あり';
  return 'なし';
}
