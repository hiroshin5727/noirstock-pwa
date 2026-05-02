import { dataUrlToBlob } from './imagePreprocess.js';

export async function runImageOcr(dataUrl, { onProgress } = {}) {
  const progress = (stage, ratio = 0) => onProgress?.({ stage, ratio });
  progress('OCRエンジン確認中', 0.08);

  // Browser-native TextDetector is used when available. On many iPhone Safari builds it is not exposed;
  // in that case callers should fall back to manual paste parsing.
  if (!('TextDetector' in window)) {
    throw new Error('このブラウザでは画像OCR APIが利用できません。iPhoneのLive Textで文字をコピーして貼り付け解析を使ってください。');
  }

  progress('画像をOCRへ渡しています', 0.22);
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  progress('文字認識中', 0.45);
  const detector = new window.TextDetector();
  const detections = await detector.detect(bitmap);
  bitmap.close?.();
  progress('OCR結果を整形中', 0.86);
  const rawText = (detections || []).map((row) => row.rawValue || row.text || '').filter(Boolean).join('\n');
  progress('完了', 1);
  return {
    engine: 'browser-textdetector',
    rawText,
    detections: detections || [],
  };
}
