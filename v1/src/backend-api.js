/* Ramagan VPS REST bridge.
 * Keeps the existing V1 screens compatible with the new self-hosted FastAPI.
 * No Supabase SDK, token, database key or service role is required.
 *
 * Login tokens are kept in sessionStorage (not localStorage). All remote API
 * writes are verified by server-side roles; UI controls do not grant rights.
 */

const PREFIX = 'ramagan.v1.session.';

export function validateServerUrl(raw) {
  const value = String(raw || '').trim();
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== 'https:') {
    const localDev = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if (!localDev) return null;
  }
  if (!u.hostname || u.hostname === '0.0.0.0') return null;
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
          return [{store_id: me.store_id, role: me.role,
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
            authorization_ref: a.p_authorization_ref
          }
        },
        ramagan_create_product: {
          endpoint: '/v1/products', payload: {
            sku: a.p_sku, name: a.p_name, category: a.p_category,
            price_satang_per_gram: a.p_price_satang_per_gram
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
      return result(() => request('POST', r.endpoint, r.payload));
    }
  };
}
