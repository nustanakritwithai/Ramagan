// Integer stock and money helpers shared by website + Android app.
// Source of truth for payable totals remains the server-side checkout RPC.
export function gramsToMilligrams(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) {
    throw new Error('ระบุจำนวนกรัมเป็นตัวเลขได้ไม่เกิน 3 ตำแหน่งทศนิยม');
  }
  const [whole, fraction = ''] = text.split('.');
  const quantity = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000) {
    throw new Error('จำนวนต่อรายการต้องมากกว่า 0 และไม่เกิน 1,000 กรัม');
  }
  return quantity;
}

export function milligramsToGrams(mg) {
  if (!Number.isSafeInteger(mg) || mg < 0) throw new Error('Invalid quantity');
  return (mg / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function lineTotalSatang(pricePerGramSatang, quantityMg) {
  if (!Number.isSafeInteger(pricePerGramSatang) || pricePerGramSatang < 0
      || !Number.isSafeInteger(quantityMg) || quantityMg < 0) {
    throw new Error('Invalid quantity or price');
  }
  const satang = Math.floor((pricePerGramSatang * quantityMg + 500) / 1000);
  if (!Number.isSafeInteger(satang)) throw new Error('Total too large');
  return satang;
}

export function formatBaht(satang) {
  if (!Number.isSafeInteger(satang)) throw new Error('Invalid amount');
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB'
  }).format(satang / 100);
}

export function bahtToSatang(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('ระบุราคาเป็นบาท ไม่เกิน 2 ตำแหน่งทศนิยม');
  }
  const [whole, fraction = ''] = text.split('.');
  const satang = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(satang) || satang < 0 || satang > 100000000) {
    throw new Error('ราคาไม่ถูกต้องหรือสูงเกินที่ระบบรองรับ');
  }
  return satang;
}
