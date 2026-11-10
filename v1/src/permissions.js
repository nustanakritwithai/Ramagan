// UI visibility never grants API rights. The VPS independently authorizes reads.
const owner = role => role === 'owner';
const allowed = (role, caps, key) => owner(role) &&
  (caps?.cost_privacy_contract_version == null ||
   (caps.cost_privacy_contract_version === 1 && caps[key] === true));
export const canViewCosts = (role, caps) => allowed(role, caps, 'can_view_costs');
export const canAccessDashboard = (role, caps) => allowed(role, caps, 'can_access_dashboard');
export const canManageSettings = (role, caps) => allowed(role, caps, 'can_manage_settings');
export const usesRedactedCosts = (role, caps) => role !== 'owner' &&
  caps?.cost_privacy_contract_version === 1 && caps.can_view_costs === false;

export const canViewStockQuantities = (role, caps) => owner(role) &&
  (caps?.stock_privacy_contract_version == null ||
   (caps.stock_privacy_contract_version === 1 && caps.can_view_stock_quantities === true));
export const usesRedactedStockQuantities = (role, caps) => role !== 'owner' &&
  caps?.stock_privacy_contract_version === 1 && caps.can_view_stock_quantities === false;
export const lotHasStock = lot => typeof lot?.has_stock === 'boolean' ? lot.has_stock : lot?.quantity_mg > 0;
export const stockLabel = (lot, visible, format) => visible ? format(lot.quantity_mg) + ' กรัม' :
  lotHasStock(lot) ? 'มีสินค้า' : 'สินค้าหมด';

// Only call this on balance snapshots, never on a sale/receive intent.
export function withoutStockBalances(value) {
  if (Array.isArray(value)) return value.map(withoutStockBalances);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'quantity_mg')
    .map(([key, item]) => [key, withoutStockBalances(item)]));
  if (Object.hasOwn(value, 'quantity_mg') && Object.hasOwn(value, 'id')) result.has_stock = value.quantity_mg > 0;
  return result;
}
export function withoutStockComparisons(value) {
  if (Array.isArray(value)) return value.map(withoutStockComparisons);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['system_quantity_mg','variance_mg'].includes(key))
    .map(([key, item]) => [key, withoutStockComparisons(item)]));
}

export function withoutPrivateCosts(value) {
  if (Array.isArray(value)) return value.map(withoutPrivateCosts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/cost|profit|margin|inventory_(?:value|delta)|value_delta_satang/i.test(key))
    .map(([key, item]) => [key, withoutPrivateCosts(item)]));
}
