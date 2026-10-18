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

export function withoutPrivateCosts(value) {
  if (Array.isArray(value)) return value.map(withoutPrivateCosts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/cost|profit|margin|inventory_(?:value|delta)|value_delta_satang/i.test(key))
    .map(([key, item]) => [key, withoutPrivateCosts(item)]));
}
