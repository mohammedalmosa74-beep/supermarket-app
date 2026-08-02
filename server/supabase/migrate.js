// =====================================================
// Migrate data.json -> Supabase (run ONCE locally)
// Usage: node supabase/migrate.js
// =====================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('خطأ: يجب تعبئة SUPABASE_URL و SUPABASE_SERVICE_KEY في ملف server/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const dataPath = path.join(__dirname, '..', 'db', 'data.json');
if (!fs.existsSync(dataPath)) {
  console.error('data.json غير موجود:', dataPath);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Column whitelists (only known schema columns)
const COLUMNS = {
  users: ['id', 'phone', 'name', 'dob', 'city', 'address', 'points', 'profile', 'createdAt', 'blocked', 'blockReason', 'adminNotes', 'adminFlag', 'usedReferral'],
  orders: ['id', 'userId', 'items', 'status', 'date', 'total', 'deliveryFee', 'discount', 'payment', 'txnId', 'address', 'lat', 'lng', 'phone', 'orderNote', 'customerName', 'deliverySlot', 'contactPhone', 'couponCode', 'deliveryDate', 'giftMessage', 'timeline', 'deliveryCode', 'archived', 'deliveryPerson', 'deliveryPersonPhone', 'deliveryAssignedAt', 'notes', 'eta', 'stockDecremented', 'cashCollected', 'deliveryNote', 'returnedAt', 'returnNote', 'returnedItems', 'cashierOrder', 'cashierId'],
  products: ['id', 'name', 'sub', 'cat', 'price', 'unit', 'image', 'image2', 'badge', 'discount', 'stock', 'active', 'preorder', 'cost', 'expiryDate'],
  categories: ['id', 'name', 'icon', 'color'],
  coupons: ['code', 'pct', 'maxUses', 'used'],
  suggestions: ['text', 'userId', 'name', 'phone', 'time'],
  adminMessages: ['phone', 'text', 'time', 'read', 'broadcast'],
  productRequests: ['name', 'desc', 'userId', 'phone', 'time'],
  adminLog: ['action', 'detail', 'time'],
  watchedProducts: ['userId', 'productId', 'addedAt'],
  referrals: ['code', 'userId', 'name', 'used', 'usedBy', 'usedAt'],
  couponUsage: ['code', 'userId', 'phone', 'orderId', 'date', 'discount'],
  reviews: ['id', 'userId', 'userName', 'productId', 'rating', 'comment', 'image', 'date'],
  tickets: ['id', 'userId', 'userName', 'subject', 'status', 'messages', 'date'],
  recurringOrders: ['id', 'userId', 'frequency', 'items', 'address', 'total', 'nextDate', 'active', 'created'],
  pointsHistory: ['userId', 'amount', 'type', 'note', 'date'],
  stockLog: ['productId', 'productName', 'oldStock', 'newStock', 'diff', 'reason', 'time'],
  deliveryPersons: ['id', 'name', 'phone', 'password', 'active', 'createdAt'],
  settings: ['storeName', 'storeAddress', 'storePhone', 'storeDesc', 'storeLogo', 'storeFacebook', 'storeInstagram', 'storeTiktok', 'storeLocation', 'deliveryFee', 'waNumber', 'adminPW', 'ptsRate', 'ptsValue', 'minOrder', 'deliverySlots', 'minFree', 'bizHours']
};

function clean(row, table) {
  const allowed = COLUMNS[table];
  const out = {};
  for (const k of allowed) {
    if (row[k] !== undefined) out[k] = row[k];
  }
  // Convert date-string timestamps to numbers where schema expects bigint
  for (const f of ['eta', 'deliveryAssignedAt', 'returnedAt', 'time', 'addedAt', 'usedAt']) {
    if (out[f] !== undefined && out[f] !== null && isNaN(out[f])) {
      const t = Date.parse(out[f]);
      if (!isNaN(t)) out[f] = t;
    }
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function migrateTable(table, rows) {
  // Delete existing rows first (idempotent re-run)
  const { error: delErr } = await supabase.from(table).delete().neq('id', -1);
  if (delErr) {
    const { error: delErr2 } = await supabase.from(table).delete().neq('code', '');
    if (delErr2) console.log('  [تنبيه حذف] ' + table + ': ' + delErr2.message);
  }
  const cleaned = rows.map(r => clean(r, table));
  let inserted = 0;
  for (const batch of chunk(cleaned, 200)) {
    const { error } = await supabase.from(table).insert(batch);
    if (error) {
      console.error('  [خطأ] ' + table + ': ' + error.message);
    } else inserted += batch.length;
  }
  console.log('- ' + table + ': ' + inserted + '/' + rows.length + ' سجل');
}

async function migrate() {
  console.log('بدء الترحيل من data.json إلى Supabase...\n');

  const DB_TABLES = ['users', 'orders', 'products', 'categories', 'coupons', 'suggestions', 'adminMessages', 'productRequests', 'adminLog', 'watchedProducts', 'referrals', 'couponUsage', 'reviews', 'tickets', 'recurringOrders', 'pointsHistory', 'stockLog', 'deliveryPersons'];

  for (const table of DB_TABLES) {
    const rows = data[table];
    if (!rows || !rows.length) { console.log('- ' + table + ': لا توجد بيانات'); continue; }
    await migrateTable(table, rows);
  }

  // Settings (single row) - strip fields that live in meta
  if (data.settings) {
    const s = clean(data.settings, 'settings') || {};
    const settings = Object.assign({ id: 1 }, s);
    delete settings.dealEnd;
    delete settings.promo;
    await supabase.from('settings').delete().eq('id', 1);
    const { error } = await supabase.from('settings').insert(settings);
    if (error) console.error('- settings: ' + error.message);
    else console.log('- settings: تم الترحيل');
  }
  // Meta: dealEnd, promo, salesGoals
  await supabase.from('meta').delete().neq('key', '');
  const meta = [
    { key: 'dealEnd', value: data.dealEnd || Date.now() },
    { key: 'promo', value: data.promo || { text: '', active: false } }
  ];
  for (const m of meta) {
    const { error } = await supabase.from('meta').insert(m);
    if (error) console.error('- meta/' + m.key + ': ' + error.message);
    else console.log('- meta/' + m.key + ': تم الترحيل');
  }
  if (data.salesGoals) {
    await supabase.from('salesGoals').delete().eq('id', 1);
    const goals = Object.assign({ id: 1 }, data.salesGoals);
    const { error } = await supabase.from('salesGoals').insert(goals);
    if (error) console.error('- salesGoals: ' + error.message);
    else console.log('- salesGoals: تم الترحيل');
  }

  console.log('\nاكتمل الترحيل!');
}

migrate().catch(e => { console.error('خطأ عام:', e.message); process.exit(1); });
