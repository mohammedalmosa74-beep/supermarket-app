// =====================================================
// Supabase-backed DB layer (lowdb-compatible API)
// =====================================================
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('خطأ: يجب تعبئة SUPABASE_URL و SUPABASE_SERVICE_KEY في ملف server/.env');
  console.error('يمكنك إيجادهما في: Supabase Dashboard > Project Settings > API');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ============ TABLE CONFIG ============
// auto: id is auto-generated (bigserial), no explicit id in rows
const ARRAY_TABLES = {
  users: { pk: 'id' },
  orders: { pk: 'id' },
  products: { pk: 'id' },
  categories: { pk: 'id' },
  coupons: { pk: 'code' },
  suggestions: { auto: true },
  adminMessages: { auto: true },
  productRequests: { auto: true },
  adminLog: { auto: true },
  watchedProducts: { auto: true },
  referrals: { pk: 'code' },
  couponUsage: { auto: true },
  reviews: { pk: 'id' },
  tickets: { pk: 'id' },
  recurringOrders: { pk: 'id' },
  pointsHistory: { auto: true },
  stockLog: { auto: true },
  deliveryPersons: { pk: 'id' }
};

const DEFAULT_SETTINGS = {
  id: 1,
  deliveryFee: 5000,
  waNumber: '938360343',
  adminPW: '$2b$10$SzTNvPLk9Zg.K1.d1L.oG.AIOEN7mBpMpngO6pbOjPScXO7hJxB9i',
  ptsRate: 0.01,
  ptsValue: 10,
  minOrder: 0,
  deliverySlots: '["9-12","12-3","3-6","6-9"]',
  minFree: 50000,
  bizHours: '{"sat":{"open":"08:00","close":"23:00"},"sun":{"open":"08:00","close":"23:00"},"mon":{"open":"08:00","close":"23:00"},"tue":{"open":"08:00","close":"23:00"},"wed":{"open":"08:00","close":"23:00"},"thu":{"open":"08:00","close":"23:00"},"fri":{"open":"09:00","close":"22:00"}}'
};

const DEFAULT_CATEGORIES = [
  { id: 1, name: 'خضار وفواكه', icon: 'fa-carrot', color: '#16A34A' },
  { id: 2, name: 'حليب ومشتقاته', icon: 'fa-cheese', color: '#2563EB' },
  { id: 3, name: 'لحوم ودجاج', icon: 'fa-drumstick-bite', color: '#DC2626' },
  { id: 4, name: 'معلبات', icon: 'fa-can-food', color: '#D97706' },
  { id: 5, name: 'مشروبات', icon: 'fa-wine-bottle', color: '#7C3AED' },
  { id: 6, name: 'تنظيف', icon: 'fa-spray-can', color: '#0891B2' },
  { id: 7, name: 'خبز ومعجنات', icon: 'fa-bread-slice', color: '#EA580C' },
  { id: 8, name: 'حلويات', icon: 'fa-candy-cane', color: '#DB2777' }
];

const DEFAULT_PRODUCTS = [
  { id: 1, name: 'طماطم', sub: 'خضار', cat: '1', price: 3000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false, cost: 0 },
  { id: 2, name: 'خيار', sub: 'خضار', cat: '1', price: 2000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false, cost: 0 },
  { id: 3, name: 'بصل', sub: 'خضار', cat: '1', price: 1500, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false, cost: 0 },
  { id: 4, name: 'بطاطا', sub: 'خضار', cat: '1', price: 2500, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false, cost: 0 },
  { id: 5, name: 'حليب طازج', sub: 'ألبان', cat: '2', price: 6000, unit: 'لتر', image: '', badge: '', discount: 0, stock: 50, active: true, preorder: false, cost: 0 },
  { id: 6, name: 'لبنة', sub: 'ألبان', cat: '2', price: 8000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 30, active: true, preorder: false, cost: 0 },
  { id: 7, name: 'جبنة بيضاء', sub: 'ألبان', cat: '2', price: 10000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 25, active: true, preorder: false, cost: 0 },
  { id: 8, name: 'دجاج', sub: 'لحوم', cat: '3', price: 15000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 40, active: true, preorder: false, cost: 0 },
  { id: 9, name: 'لحم عجل', sub: 'لحوم', cat: '3', price: 35000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 30, active: true, preorder: false, cost: 0 },
  { id: 10, name: 'بيض', sub: 'بيض', cat: '3', price: 12000, unit: 'كرتونة', image: '', badge: '', discount: 0, stock: 60, active: true, preorder: false, cost: 0 }
];

// ============ STATE ============
const state = {};
const opQueue = [];
let persistTimer = null;
let refreshTimer = null;
let refreshing = false;
// Keys (table:pk) of rows whose ops are still pending (insert not yet confirmed)
const pendingKeys = new Set();

// ============ HELPERS ============
function looseEq(a, b) {
  return a === b || String(a) === String(b);
}

function matches(item, query) {
  if (typeof query === 'function') return !!query(item);
  for (const k in query) {
    if (!(k in item) || !looseEq(item[k], query[k])) return false;
  }
  return true;
}

function sortBy(arr, field, dir) {
  return arr.slice().sort(function(a, b) {
    var va = a[field], vb = b[field];
    if (va === undefined) va = '';
    if (vb === undefined) vb = '';
    if (va === vb) return 0;
    if (dir === 'desc') return va > vb ? -1 : 1;
    return va > vb ? 1 : -1;
  });
}

// ============ LOAD FROM SUPABASE ============
async function loadArrayTable(name) {
  const { data, error } = await supabase.from(name).select('*');
  if (error) throw new Error('تحميل جدول ' + name + ': ' + error.message);
  state[name] = data || [];
}

async function loadMeta() {
  const { data, error } = await supabase.from('meta').select('*');
  if (error) throw new Error('تحميل meta: ' + error.message);
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  state.dealEnd = map.dealEnd !== undefined ? map.dealEnd : (Date.now() + 8 * 3600000);
  state.promo = map.promo !== undefined ? map.promo : { text: '', active: false };
  if (map.dealEnd === undefined) {
    await supabase.from('meta').upsert({ key: 'dealEnd', value: state.dealEnd }, { onConflict: 'key' });
  }
  if (map.promo === undefined) {
    await supabase.from('meta').upsert({ key: 'promo', value: state.promo }, { onConflict: 'key' });
  }
}

async function loadObjectTable(name, defaults) {
  const { data, error } = await supabase.from(name).select('*').eq('id', 1);
  if (error) throw new Error('تحميل ' + name + ': ' + error.message);
  if (data && data.length) {
    state[name] = data[0];
  } else {
    state[name] = Object.assign({}, defaults);
    await supabase.from(name).upsert(state[name], { onConflict: 'id' });
  }
}

async function init() {
  for (const name of Object.keys(ARRAY_TABLES)) await loadArrayTable(name);
  await loadMeta();
  await loadObjectTable('settings', DEFAULT_SETTINGS);
  await loadObjectTable('salesGoals', { id: 1, daily: 500000, weekly: 3000000, monthly: 12000000 });
  if (!state.categories.length) {
    state.categories = DEFAULT_CATEGORIES.map(c => Object.assign({}, c));
    await supabase.from('categories').upsert(state.categories, { onConflict: 'id' });
  }
  if (!state.products.length) {
    state.products = DEFAULT_PRODUCTS.map(p => Object.assign({}, p));
    await supabase.from('products').upsert(state.products, { onConflict: 'id' });
  }
  refreshTimer = setInterval(refreshAll, 60000);
}

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    for (const name of Object.keys(ARRAY_TABLES)) {
      const { data } = await supabase.from(name).select('*');
      if (!data) continue;
      const cfg = ARRAY_TABLES[name];
      if (cfg.pk) {
        const dbKeys = new Set(data.map(r => String(r[cfg.pk])));
        // Only re-merge rows whose ops are still pending (not yet confirmed in DB)
        const missing = (state[name] || []).filter(r =>
          r[cfg.pk] !== undefined && !dbKeys.has(String(r[cfg.pk])) && pendingKeys.has(name + ':' + String(r[cfg.pk]))
        );
        if (missing.length) {
          queueOp(name, { type: 'insert', rows: missing });
        }
        state[name] = data.concat(missing);
      } else {
        state[name] = data;
      }
    }
  } catch (e) { console.error('Refresh error:', e.message); }
  refreshing = false;
}

// ============ PERSIST QUEUE ============
function queueOp(table, op) {
  opQueue.push({ table: table, op: op });
  const cfg = ARRAY_TABLES[table];
  if (op.type === 'insert' && cfg && cfg.pk && op.rows) {
    op.rows.forEach(function(r) {
      if (r[cfg.pk] !== undefined) pendingKeys.add(table + ':' + String(r[cfg.pk]));
    });
  }
  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushQueue, 200);
}

async function flushQueue() {
  persistTimer = null;
  if (!opQueue.length) return;
  const batch = opQueue.splice(0);
  const retryOps = [];
  for (const { table, op } of batch) {
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      try {
        await applyOp(table, op);
        ok = true;
      } catch (e) {
        if (attempt === 4) {
          console.error('خطأ في الحفظ للجدول ' + table + ' (بعد 5 محاولات):', e.message);
        } else {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        }
      }
    }
    if (ok) {
      const cfg = ARRAY_TABLES[table];
      if (op.type === 'insert' && cfg && cfg.pk && op.rows) {
        op.rows.forEach(function(r) {
          if (r[cfg.pk] !== undefined) pendingKeys.delete(table + ':' + String(r[cfg.pk]));
        });
      }
    } else {
      retryOps.push({ table: table, op: op });
    }
  }
  if (retryOps.length) {
    opQueue.unshift(...retryOps);
    schedulePersistRetry();
  }
}

function schedulePersistRetry() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushQueue, 10000);
}

async function insertWithFallback(table, row, cfg) {
  let current = row;
  for (let attempt = 0; attempt < 25; attempt++) {
    let result;
    if (cfg.auto) {
      result = await supabase.from(table).insert(current);
    } else {
      const { error } = await supabase.from(table).upsert(current, { onConflict: cfg.pk });
      result = { error };
    }
    if (!result.error) return;
    const m = /Could not find the '([^']+)' column/.exec(result.error.message);
    if (!m) throw new Error(result.error.message);
    const stripped = {};
    for (const k in current) if (k !== m[1]) stripped[k] = current[k];
    current = stripped;
  }
  throw new Error('تعذر الإدراج في ' + table + ': أعمدة غير معروفة');
}

async function applyOp(table, op) {
  const cfg = ARRAY_TABLES[table];
  if (op.type === 'insert') {
    for (const row of op.rows) await insertWithFallback(table, row, cfg);
  } else if (op.type === 'update') {
    const { error } = await supabase.from(table).update(op.updates).eq(op.pkField, op.pkValue);
    if (error) throw new Error(error.message);
  } else if (op.type === 'remove') {
    const q = op.query;
    if (typeof q === 'function') throw new Error('remove with function not supported');
    let query = supabase.from(table).delete();
    for (const k in q) query = query.eq(k, q[k]);
    const { error } = await query;
    if (error) throw new Error(error.message);
  } else if (op.type === 'replaceAll') {
    const { error: delErr } = await supabase.from(table).delete().neq('id', -1);
    if (delErr) throw new Error(delErr.message);
    const rows = op.rows || [];
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase.from(table).insert(rows.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }
  } else if (op.type === 'settings') {
    const { error } = await supabase.from(table).upsert(op.row, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  } else if (op.type === 'meta') {
    const { error } = await supabase.from('meta').upsert({ key: op.key, value: op.value }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
  }
}

// ============ CHAIN API (lowdb-compatible) ============
const OBJECT_TABLES = { settings: true, salesGoals: true };

function chain(name) {
  const isObject = OBJECT_TABLES[name];
  const isMeta = (name === 'dealEnd' || name === 'promo');
  const c = {
    _name: name,
    _query: null,
    _singular: false,
    _transform: null,
    _el: null,

    value() {
      if (isObject || isMeta) return state[name];
      let result;
      if (this._query) {
        const found = state[name].filter(item => matches(item, this._query));
        result = this._singular ? found[0] : found;
      } else {
        result = state[name].slice();
      }
      if (this._transform) result = this._transform(result);
      if (this._singular && result !== undefined && result !== null && result === state[name][0]) {
        this._el = result;
      }
      return result;
    },

    find(q) { this._query = q; this._singular = true; return this; },
    filter(q) { this._query = q; this._singular = false; return this; },

    orderBy(field, dir) {
      const prev = this._transform;
      this._transform = prev ? arr => prev(sortBy(arr, field, dir)) : arr => sortBy(arr, field, dir);
      return this;
    },

    take(n) {
      const prev = this._transform;
      this._transform = prev ? arr => prev(arr.slice(0, n)) : arr => arr.slice(0, n);
      return this;
    },

    maxBy(field) {
      this._transform = arr => {
        if (!arr.length) return undefined;
        return arr.reduce((m, x) => (x[field] > m[field] ? x : m));
      };
      return this;
    },

    push(...items) {
      items.forEach(it => state[name].push(it));
      queueOp(name, { type: 'insert', rows: items });
      return this;
    },

    assign(updates) {
      let target;
      if (isObject) {
        target = state[name];
        Object.assign(target, updates);
        queueOp(name, { type: 'settings', row: target });
        return this;
      }
      const val = this.value();
      if (val && typeof val === 'object') {
        target = val;
        Object.assign(target, updates);
        // find pk from the query
        const pkField = ARRAY_TABLES[name].pk;
        let pkValue;
        if (this._query && this._query[pkField] !== undefined) pkValue = this._query[pkField];
        else pkValue = target[pkField];
        if (pkValue !== undefined) {
          queueOp(name, { type: 'update', updates: updates, pkField: pkField, pkValue: pkValue });
        }
      }
      return this;
    },

    update(field, fn) {
      const val = this.value();
      if (val && typeof val === 'object') {
        val[field] = fn(val[field]);
        const pkField = ARRAY_TABLES[name].pk;
        let pkValue;
        if (this._query && this._query[pkField] !== undefined) pkValue = this._query[pkField];
        else pkValue = val[pkField];
        if (pkValue !== undefined) {
          const updates = {};
          updates[field] = val[field];
          queueOp(name, { type: 'update', updates: updates, pkField: pkField, pkValue: pkValue });
        }
      }
      return this;
    },

    remove(query) {
      const before = state[name].slice();
      const after = before.filter(item => !matches(item, query));
      state[name] = after;
      queueOp(name, { type: 'remove', query: query });
      return this;
    },

    set(val) {
      if (isMeta) {
        state[name] = val;
        queueOp(name, { type: 'meta', key: name, value: val });
      } else if (isObject) {
        state[name] = Object.assign({}, val, { id: 1 });
        queueOp(name, { type: 'settings', row: state[name] });
      } else {
        state[name] = (val || []).slice();
        queueOp(name, { type: 'replaceAll', rows: state[name] });
      }
      return this;
    },

    write() { return this; }
  };
  return c;
}

// ============ PUBLIC API ============
module.exports = {
  ready: init(),
  get(name) { return chain(name); },
  set(name, val) { return chain(name).set(val); },
  defaults() { return { write() {} }; },
  getState() { return state; },
  supabase
};
