// Shrinks a phone photo before upload: about 1,500px on the long side is all Claude
// needs to read a card, and it keeps uploads fast on a phone connection.
export async function resizeForUpload(file, maxEdge = 1568, quality = 0.85) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bitmap = await createImageBitmap(file); }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('Could not compress the photo.'))), 'image/jpeg', quality,
  ));
}
