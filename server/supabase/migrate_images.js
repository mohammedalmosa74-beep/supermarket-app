// =====================================================
// Upload local images (server/public/uploads/*) to Supabase Storage
// Usage: node supabase/migrate_images.js
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

const BUCKET = process.env.SUPABASE_BUCKET || 'product-images';
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

async function main() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets || !buckets.some(b => b.name === BUCKET)) {
    await supabase.storage.createBucket(BUCKET, { public: true });
    console.log('Bucket تم إنشاؤه: ' + BUCKET);
  } else {
    console.log('Bucket موجود مسبقاً: ' + BUCKET);
  }

  if (!fs.existsSync(UPLOADS_DIR)) {
    console.log('لا يوجد مجلد uploads محلي');
    return;
  }

  const files = fs.readdirSync(UPLOADS_DIR);
  let ok = 0, skipped = 0;
  for (const f of files) {
    const filePath = path.join(UPLOADS_DIR, f);
    if (!fs.statSync(filePath).isFile()) continue;
    const buf = fs.readFileSync(filePath);
    const { data: existing } = await supabase.storage.from(BUCKET).list('', { search: f });
    if (existing && existing.length) { skipped++; continue; }
    const { error } = await supabase.storage.from(BUCKET).upload(f, buf, { upsert: false });
    if (error) {
      // maybe exists already
      const { error: e2 } = await supabase.storage.from(BUCKET).upload(f, buf, { upsert: true });
      if (e2) console.log('  [خطأ] ' + f + ': ' + e2.message);
      else { ok++; console.log('  [محدّث] ' + f); }
    } else { ok++; console.log('  [تم] ' + f); }
  }
  console.log('\nتم رفع ' + ok + ' صورة، ' + skipped + ' موجودة مسبقاً.');
  console.log('\nملاحظة: الروابط القديمة في قاعدة البيانات (تبدأ بـ /uploads/) تحتاج تحديثاً.\nيمكنك فعل ذلك من لوحة Supabase: جدول products -> تحديث عمود image\nأو أعد رفع الصور من لوحة الأدمن.');
}

main().catch(e => { console.error('خطأ عام:', e.message); process.exit(1); });
