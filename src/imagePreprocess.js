export function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = dataUrl;
  });
}

export async function preprocessEvidenceImage(dataUrl, options = {}) {
  const maxWidth = options.maxWidth || 1400;
  const quality = options.quality || 0.86;
  const img = await loadImageFromDataUrl(dataUrl);
  const scale = Math.min(1, maxWidth / Math.max(1, img.naturalWidth || img.width));
  const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  // 軽いコントラスト補正。iPhone上で重くなりすぎないように控えめにする。
  try {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const contrast = 1.12;
    const brightness = 4;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const v = ((data[i + c] - 128) * contrast) + 128 + brightness;
        data[i + c] = Math.max(0, Math.min(255, v));
      }
    }
    ctx.putImageData(imageData, 0, 0);
  } catch (error) {
    // Canvas制約で失敗しても元画像の縮小版は使う。
  }

  const processedDataUrl = canvas.toDataURL('image/jpeg', quality);
  return {
    dataUrl: processedDataUrl,
    width,
    height,
    originalWidth: img.naturalWidth || img.width,
    originalHeight: img.naturalHeight || img.height,
    byteLength: Math.round((processedDataUrl.length * 3) / 4),
  };
}

export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
