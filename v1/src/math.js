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
  // Intermediate multiplication can exceed Number's exact integer range even
  // when the rounded result is safe. Keep half-up rounding exact throughout.
  const satang = (BigInt(pricePerGramSatang) * BigInt(quantityMg) + 500n) / 1000n;
  if (satang > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Total too large');
  return Number(satang);
}

export function formatBaht(satang) {
  if (!Number.isSafeInteger(satang)) throw new Error('Invalid amount');
  const value = BigInt(satang);
  const whole = value / 100n;
  const fraction = (value < 0n ? -value : value) % 100n;
  const negativeFraction = value < 0n && whole === 0n;
  const parts = new Intl.NumberFormat('th-TH', {
    style: 'currency', currency: 'THB'
  }).formatToParts(negativeFraction ? -1n : whole);
  return parts.map(part => part.type === 'fraction' ? String(fraction).padStart(2, '0') :
    negativeFraction && part.type === 'integer' ? '0' : part.value).join('');
}

// Form inputs must remain decimal strings: coercion can hide invalid types or
// precision already lost before validation.
function parseBaht(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new Error('ระบุราคาเป็นบาท ไม่เกิน 2 ตำแหน่งทศนิยม');
  }
  const [whole, fraction = ''] = value.trim().split('.');
  const satang = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (satang > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('ราคาไม่ถูกต้องหรือสูงเกินที่ระบบรองรับ');
  }
  return Number(satang);
}

export function bahtToSatang(value) {
  const satang = parseBaht(value);
  // Preserve the existing per-gram product-price ceiling.
  if (satang > 100_000_000) {
    throw new Error('ราคาไม่ถูกต้องหรือสูงเกินที่ระบบรองรับ');
  }
  return satang;
}

export function discountSatang(value, subtotal) {
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) {
    throw new Error('Invalid subtotal');
  }
  const discount = parseBaht(value);
  if (discount > subtotal) throw new Error('ส่วนลดต้องไม่เกินยอดรวมสินค้า');
  return discount;
}

export function sumSatang(values) {
  if (!Array.isArray(values)) throw new Error('Invalid amounts');
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid amount');
    total += BigInt(value);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Total too large');
  }
  return Number(total);
}
