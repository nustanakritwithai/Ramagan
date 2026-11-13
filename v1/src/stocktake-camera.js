import {Capacitor} from '@capacitor/core';

export const hasNativeCamera = () => Capacitor.isNativePlatform();

// Camera and album are deliberately separate actions. Never fall back to an
// album picker after a native camera error; the user asked to take a new photo.
export async function cameraPhotoBlob(camera, readFile = url => fetch(url), source = 'camera') {
  let photo;
  try {
    // The pinned plugin's getPhoto camera flow saves its Activity callback and
    // file path for App.appRestoredResult; takePhoto's Ion flow does not.
    photo = await camera.getPhoto({source: source === 'album' ? 'PHOTOS' : 'CAMERA',
      resultType: 'uri', quality: 85, width: 1600, height: 1600,
      correctOrientation: true, saveToGallery: false, allowEditing: false});
  } catch (error) {
    if (error?.code === 'OS-PLUG-CAMR-0006' || /cancelled|canceled|no image picked/i.test(error?.message || '')) return null;
    if (error?.code === 'OS-PLUG-CAMR-0003' || /permission|denied/i.test(error?.message || '')) {
      throw new Error('เปิดกล้องไม่ได้ กรุณาอนุญาตกล้องให้ Ramagan POS 2 ในการตั้งค่ามือถือ แล้วลองอีกครั้ง');
    }
    throw new Error(source === 'album' ? 'เปิดอัลบั้มไม่สำเร็จ กรุณาลองเลือกรูปอีกครั้ง' : 'เปิดกล้องไม่สำเร็จ กรุณาตรวจสอบกล้องของเครื่องแล้วลองอีกครั้ง');
  }
  return readNativePhoto(photo, readFile);
}

export async function readNativePhoto(photo, readFile = url => fetch(url)) {
  const path = photo?.webPath || (photo?.path ? Capacitor.convertFileSrc(photo.path) : null);
  if (!path) throw new Error('ไม่ได้รับรูปจากกล้อง กรุณาถ่ายรูปอีกครั้ง');
  let blob;
  try {
    const response = await readFile(path);
    if (!response.ok) throw new Error('unreadable camera file');
    blob = await response.blob();
  } catch {
    throw new Error('อ่านรูปจากกล้องไม่ได้ กรุณาถ่ายรูปอีกครั้ง');
  }
  if (!blob.size) throw new Error('ไม่ได้รับข้อมูลรูป กรุณาเลือกรูปอีกครั้ง');
  return blob;
}

export async function takeStockPhoto(source = 'camera') {
  const {Camera} = await import('@capacitor/camera');
  return cameraPhotoBlob(Camera, undefined, source);
}

export async function listenForRestoredPhoto(handler) {
  if (!hasNativeCamera()) return null;
  const {App} = await import('@capacitor/app');
  return App.addListener('appRestoredResult', result => {
    if (result.pluginId === 'Camera' && result.methodName === 'getPhoto') void handler(result);
  });
}
