/* Ramagan VPS REST bridge.
 * Keeps the existing V1 screens compatible with the new self-hosted FastAPI.
 * No Supabase SDK, token, database key or service role is required.
 *
 * Login tokens are kept in sessionStorage (not localStorage). All remote API
 * writes are verified by server-side roles; UI controls do not grant rights.
 */

import {supportsDiscount} from './checkout.js';

const PREFIX = 'ramagan.v1.session.';

export function validateServerUrl(raw) {
  const text = String(raw || '');
  // URL() silently removes tabs/newlines and encodes invisible suffixes. Such a
  // visually identical endpoint can reach a different route. Reject, never fix it.
  if (/[\p{Cc}\p{Cf}]/u.test(text)) return null;
  const value = text.trim();
  if (/\s/u.test(value) || value.includes('\\')) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== 'https:') {
    const localDev = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if (!localDev) return null;
  }
  if (!u.hostname || u.hostname === '0.0.0.0') return null;
  try {
    const path = decodeURIComponent(u.pathname);
    if (/[\p{Cc}\p{Cf}\s\\?#]/u.test(path) || /%[0-9a-f]{2}/i.test(path)) return null;
  } catch { return null; }
  // Backend may be proxied under /ramagan-api; preserve the path prefix.
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export function createClient(serverUrl) {
  const base = validateServerUrl(serverUrl);
  if (!base) throw new Error('ต้องระบุ URL HTTPS ของ Ramagan API');
  const sessionKey = PREFIX + base;
  let token = sessionStorage.getItem(sessionKey) || '';
  const listeners = [];

  const request = async (method, endpoint, payload) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(base + endpoint, {
        method,
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          ...(payload === undefined ? {} : {'Content-Type': 'application/json'}),
          ...(token ? {'Authorization': 'Bearer ' + token} : {})
        },
        ...(payload === undefined ? {} : {body: JSON.stringify(payload)})
      });
      let data;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) {
        const msg = typeof data?.detail === 'string' ? data.detail :
          'HTTP ' + res.status;
        const error = new Error(msg);
        error.status = res.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const e = new Error('หมดเวลารอคำตอบจากเซิร์ฟเวอร์ ยังไม่ทราบผลธุรกรรม');
        e.status = 0;
        throw e;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  async function result(task, fallback = null) {
    try { return {data: await task(), error: null}; }
    catch (error) { return {data: fallback, error}; }
  }

  class Query {
    constructor(name) { this.table = name; this.filters = {}; }
    select() { return this; }
    eq(field, value) { this.filters[field] = value; return this; }
    limit() { return this; }
    order() { return this; }
    maybeSingle() { return this.execute(true); }
    then(resolve, reject) { return this.execute(false).then(resolve, reject); }
    async execute(single) {
      return result(async () => {
        if (this.table === 'ramagan_members') {
          const me = await request('GET', '/v1/me');
          return [{store_id: me.store_id, role: me.role, capabilities: me.capabilities,
                   ramagan_stores: {
                     name: me.store.name,
                     sales_enabled: me.store.sales_enabled,
                     requires_authorization: me.store.requires_authorization
                   }}];
        }
        if (this.table === 'ramagan_products' || this.table === 'ramagan_lots') {
          const catalog = await request('GET', '/v1/catalog');
          const filterStore = (row) => !this.filters.store_id ||
            String(this.filters.store_id) === String(row.store_id || meStore);
          const meStore = this.filters.store_id;
          if (this.table === 'ramagan_products') {
            return catalog.products.filter(filterStore).map(p => ({
              id: p.id, sku: p.sku, name: p.name, category: p.category,
              price_satang_per_gram: p.price_satang_per_gram, active: !!p.active
            }));
          }
          return catalog.lots.map(l => ({
            id: l.id, lot_code: l.lot_code, expires_on: l.expires_on, active: !!l.active,
            ramagan_products: {
              name: l.name, sku: l.sku,
              price_satang_per_gram: l.price_satang_per_gram,
              active: !!l.product_active
            },
            ramagan_lot_balances: {quantity_mg: l.quantity_mg}
          }));
        }
        if (this.table === 'ramagan_sales') {
          const id = this.filters.client_sale_id;
          if (!id) throw new Error('Missing client_sale_id');
          try {
            const x = await request('GET', '/v1/sales/by-client/' + encodeURIComponent(id));
            return x;
          } catch (e) {
            if (e.status === 404) return null;
            throw e;
          }
        }
        throw new Error('Unsupported table: ' + this.table);
      }, single ? null : []);
    }
  }

  return {
    base,
    health: () => result(() => request('GET', '/health')),
    inventory: () => result(() => request('GET', '/v1/inventory')),
    stocktakes: () => result(() => request('GET', '/v1/stocktakes')),
    stocktake: id => result(() => request('GET', '/v1/stocktakes/by-client/' + encodeURIComponent(id))),
    inventoryTransport(kind) {
      return {
        async capabilities(identity) {
          const me = await request('GET', '/v1/me');
          if (me.user?.id !== identity.actor || me.store_id !== identity.store ||
              !['owner', 'manager'].includes(me.role)) {
            throw new Error('บัญชี ร้าน หรือสิทธิ์เปลี่ยนไป กรุณาใช้บัญชีผู้จัดการเดิม');
          }
          return me.capabilities;
        },
        post: payload => request('POST', kind === 'stocktake' ? '/v1/stocktakes' : '/v1/lots/receive', payload),
        reconcile: payload => request('POST', kind === 'stocktake' ? '/v1/stocktakes/reconcile' : '/v1/lots/receive/reconcile', payload),
        ...(kind === 'stocktake' ? {async lookup(id) {
          try { return await request('GET', '/v1/stocktakes/by-client/' + encodeURIComponent(id)); }
          catch (error) { if (error.status === 404) return null; throw error; }
        }} : {})
      };
    },
    checkoutTransport: {
      async capabilities(identity) {
        const me = await request('GET', '/v1/me');
        if (me.user?.id !== identity.cashier || me.store_id !== identity.store) {
          throw new Error('บัญชีหรือร้านเปลี่ยนไป กรุณาเข้าสู่ระบบบัญชีเดิม');
        }
        return me.capabilities;
      },
      post: payload => request('POST', '/v1/sales', payload),
      async lookup(id) {
        try { return await request('GET', '/v1/sales/by-client/' + encodeURIComponent(id)); }
        catch (error) { if (error.status === 404) return null; throw error; }
      }
    },
    auth: {
      async getUser() {
        if (!token) return {data: {user: null}, error: null};
        const check = await result(() => request('GET', '/v1/me'));
        if (check.error) {
          if (check.error.status === 401) {
            token = '';
            sessionStorage.removeItem(sessionKey);
          }
          return {data: {user: null}, error: check.error};
        }
        return {data: {user: check.data.user}, error: null};
      },
      async signInWithPassword({email, password}) {
        const login = await result(() => request('POST', '/v1/auth/login', {email,password}));
        if (login.error) return login;
        token = login.data.token;
        sessionStorage.setItem(sessionKey, token);
        return {data: {user: login.data.user}, error: null};
      },
      async signOut() {
        await result(() => request('POST', '/v1/auth/logout', {}));
        token = '';
        sessionStorage.removeItem(sessionKey);
        for (const fn of listeners) fn('SIGNED_OUT');
        return {error: null};
      },
      onAuthStateChange(callback) {
        listeners.push(callback);
        return {data: {subscription: {unsubscribe: () => {
          const i = listeners.indexOf(callback);
          if (i !== -1) listeners.splice(i, 1);
        }}}};
      }
    },
    from: (table) => new Query(table),
    rpc: async (name, args) => {
      const a = args || {};
      const routes = {
        ramagan_checkout: {
          endpoint: '/v1/sales', payload: {
            client_sale_id: a.p_client_sale_id,
            items: a.p_items, payment_method: a.p_payment_method,
            authorization_ref: a.p_authorization_ref,
            discount_satang: a.p_discount_satang ?? 0
          }
        },
        ramagan_create_product: {
          endpoint: '/v1/products', payload: {
            sku: a.p_sku, name: a.p_name, category: a.p_category,
            price_satang_per_gram: a.p_price_satang_per_gram,
            ...(a.p_default_cost_satang_per_gram === undefined ? {} :
              {default_cost_satang_per_gram: a.p_default_cost_satang_per_gram})
          }
        },
        ramagan_receive_lot: {
          endpoint: '/v1/lots/receive', payload: {
            product_id: a.p_product_id, lot_code: a.p_lot_code,
            supplier_name: a.p_supplier_name,
            supplier_document_ref: a.p_supplier_document_ref,
            quantity_mg: a.p_quantity_mg, expires_on: a.p_expires_on,
            reason: a.p_reason
          }
        }
      };
      if (!routes[name]) return {data: null, error: new Error('Unknown action')};
      const r = routes[name];
      return result(async () => {
        if (name === 'ramagan_checkout') {
          if (!Number.isSafeInteger(r.payload.discount_satang) || r.payload.discount_satang < 0) {
            throw new Error('Invalid discount');
          }
          if (r.payload.discount_satang > 0) {
            const me = await request('GET', '/v1/me');
            if (!supportsDiscount(me.capabilities)) throw new Error('เซิร์ฟเวอร์ยังไม่รองรับส่วนลดรุ่นนี้');
          }
        }
        return request('POST', r.endpoint, r.payload);
      });
    }
  };
}
