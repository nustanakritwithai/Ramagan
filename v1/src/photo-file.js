import {validatePhoto} from './evidence-draft.js';

// Bound uploads before saving the durable retry bytes. The server still checks
// the actual format and dimensions independently. Never use a thumbnail as proof.
export function photoDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 64_000_000) {
    throw new Error('รูปมีความละเอียดสูงเกินไป กรุณาเลือกรูปขนาดเล็กลง');
  }
  const ratio = Math.min(1, 1600 / Math.max(width, height));
  return {width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio))};
}

async function decodePhoto(blob) {
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {image.src = ''; reject(new Error('อ่านรูปไม่สำเร็จ กรุณาเลือกรูปอีกครั้ง'));}, 20000);
      image.onload = () => {clearTimeout(timer); resolve();};
      image.onerror = () => {clearTimeout(timer); reject(new Error('อ่านรูปไม่ได้ กรุณาใช้รูป JPEG, PNG หรือ WebP'));};
      image.src = url;
    });
    return {image, width: image.naturalWidth, height: image.naturalHeight, close: () => {image.src = ''; URL.revokeObjectURL(url);}};
  } catch (error) {URL.revokeObjectURL(url); throw error;}
}

export async function preparePhoto(blob, {decode = decodePhoto, canvas = () => document.createElement('canvas')} = {}) {
  if (!blob || !['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) || !blob.size || blob.size > 30 * 1024 * 1024) {
    throw new Error('เลือกรูป JPEG, PNG หรือ WebP ขนาดไม่เกิน 30 MB');
  }
  const decoded = await decode(blob);
  let surface;
  try {
    const size = photoDimensions(decoded.width, decoded.height);
    // Native capture already returns a bounded JPEG. Decoding still validates
    // the image/dimensions; avoid another lossy canvas encode when it fits.
    // The API independently normalizes orientation and strips EXIF on upload.
    if (blob.type === 'image/jpeg' && blob.size <= 1024 * 1024 &&
        size.width === decoded.width && size.height === decoded.height) {
      validatePhoto(blob); return blob;
    }
    surface = canvas(); surface.width = size.width; surface.height = size.height;
    const context = surface.getContext('2d');
    if (!context) throw new Error('เครื่องนี้เตรียมรูปไม่ได้ กรุณาปิดแล้วเปิดแอปอีกครั้ง');
    context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height);
    context.drawImage(decoded.image, 0, 0, size.width, size.height);
    for (const quality of [.86, .72, .58]) {
      const result = await new Promise(resolve => surface.toBlob(resolve, 'image/jpeg', quality));
      if (result?.size && result.size <= 1024 * 1024) {validatePhoto(result); return result;}
    }
    throw new Error('ย่อรูปไม่สำเร็จ กรุณาเลือกรูปขนาดเล็กลง');
  } finally {decoded.close?.(); if (surface) {surface.width = 0; surface.height = 0;}}
}
