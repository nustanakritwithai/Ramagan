import {Capacitor} from '@capacitor/core';
import {validatePhoto} from './evidence-draft.js';

export const hasNativeCamera = () => Capacitor.isNativePlatform();

// Camera and album are deliberately separate actions. Never fall back to an
// album picker after a native camera error; the user asked to take a new photo.
export async function cameraPhotoBlob(camera, readFile = url => fetch(url)) {
  let photo;
  try {
    photo = await camera.takePhoto({quality: 90, targetWidth: 2048, targetHeight: 2048,
      correctOrientation: true, saveToGallery: false, editable: 'no'});
  } catch (error) {
    if (error?.code === 'OS-PLUG-CAMR-0006') return null;
    if (error?.code === 'OS-PLUG-CAMR-0003') {
      throw new Error('เปิดกล้องไม่ได้ กรุณาอนุญาตกล้องให้ Ramagan POS 2 ในการตั้งค่ามือถือ แล้วลองอีกครั้ง');
    }
    throw new Error('เปิดกล้องไม่สำเร็จ กรุณาตรวจสอบกล้องของเครื่องแล้วลองอีกครั้ง');
  }
  if (!photo?.webPath) throw new Error('ไม่ได้รับรูปจากกล้อง กรุณาถ่ายรูปอีกครั้ง');
  let blob;
  try {
    const response = await readFile(photo.webPath);
    if (!response.ok) throw new Error('unreadable camera file');
    blob = await response.blob();
  } catch {
    throw new Error('อ่านรูปจากกล้องไม่ได้ กรุณาถ่ายรูปอีกครั้ง');
  }
  validatePhoto(blob);
  return blob;
}

export async function takeStockPhoto() {
  const {Camera} = await import('@capacitor/camera');
  return cameraPhotoBlob(Camera);
}
