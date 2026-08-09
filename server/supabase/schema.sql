-- =====================================================
-- Supermarket App - Supabase Schema
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query
-- =====================================================

-- USERS
create table if not exists users (
  id text primary key,
  phone text unique not null,
  name text default '',
  dob text default '',
  city text default '',
  address text default '',
  points integer default 0,
  profile jsonb default '{}'::jsonb,
  "createdAt" text default '',
  blocked boolean default false,
  "blockReason" text default '',
  "adminNotes" text default '',
  "adminFlag" text default '',
  "usedReferral" boolean default false,
  "passwordHash" text default '',
  "pwVer" integer default 1
);

-- ORDERS
create table if not exists orders (
  id text primary key,
  "userId" text default '',
  items jsonb default '[]'::jsonb,
  status text default 'pending',
  date text default '',
  total numeric default 0,
  "deliveryFee" numeric default 0,
  discount numeric default 0,
  payment text default 'cash',
  "txnId" text default '',
  address text default '',
  lat numeric,
  lng numeric,
  floor text default '',
  phone text default '',
  "orderNote" text default '',
  "customerName" text default '',
  "deliverySlot" text default '',
  "contactPhone" text default '',
  "couponCode" text default '',
  "deliveryDate" text default '',
  "giftMessage" text default '',
  timeline jsonb default '{}'::jsonb,
  "deliveryCode" text default '',
  archived boolean default false,
  "deliveryPerson" text default '',
  "deliveryPersonPhone" text default '',
  "deliveryAssignedAt" bigint,
  notes text default '',
  eta bigint,
  "stockDecremented" boolean default false,
  "cashCollected" numeric,
  "deliveryNote" text default '',
  "returnedAt" bigint,
  "returnNote" text default '',
  "returnedItems" jsonb default '[]'::jsonb,
  "cashierOrder" boolean default false,
  "cashierId" text default ''
);

-- PRODUCTS
create table if not exists products (
  id serial primary key,
  name text not null,
  sub text default '',
  cat text default '',
  category text default '',
  price numeric default 0,
  unit text default '',
  image text default '',
  image2 text default '',
  badge text default '',
  discount numeric default 0,
  stock integer default 0,
  active boolean default true,
  preorder boolean default false,
  cost numeric default 0,
  description text default '',
  tags text default '',
  "expiryDate" text default ''
);

-- CATEGORIES
create table if not exists categories (
  id serial primary key,
  name text not null,
  icon text default 'fa-tag',
  color text default '#6B7280'
);

-- COUPONS
create table if not exists coupons (
  code text primary key,
  pct numeric default 0,
  "maxUses" integer default 100,
  used integer default 0
);

-- SUGGESTIONS
create table if not exists suggestions (
  id bigserial primary key,
  text text default '',
  "userId" text default '',
  name text default '',
  phone text default '',
  time bigint default 0
);

-- ADMIN MESSAGES
create table if not exists "adminMessages" (
  id bigserial primary key,
  phone text default '',
  text text default '',
  time bigint default 0,
  read boolean default false,
  broadcast boolean default false
);

-- PRODUCT REQUESTS
create table if not exists "productRequests" (
  id bigserial primary key,
  name text default '',
  "desc" text default '',
  "userId" text default '',
  phone text default '',
  time bigint default 0
);

-- ADMIN LOG
create table if not exists "adminLog" (
  id bigserial primary key,
  action text default '',
  detail text default '',
  time bigint default 0
);

-- SETTINGS (single row, id=1)
create table if not exists settings (
  id integer primary key default 1,
  "storeName" text default '',
  "storeAddress" text default '',
  "storePhone" text default '',
  "storeDesc" text default '',
  "storeLogo" text default '',
  "storeFacebook" text default '',
  "storeInstagram" text default '',
  "storeTiktok" text default '',
  "storeLocation" text default '',
  "deliveryFee" numeric default 5000,
  "waNumber" text default '',
  "adminPW" text default '',
  "adminVer" integer default 1,
  "ptsRate" numeric default 0.01,
  "ptsValue" numeric default 10,
  "minOrder" numeric default 0,
  "deliverySlots" text default '["9-12","12-3","3-6","6-9"]',
  "minFree" numeric default 50000,
  "bizHours" text default '{}'
);

-- META (key-value: dealEnd, promo, salesGoals)
create table if not exists meta (
  key text primary key,
  value jsonb default '{}'::jsonb
);

-- WATCHED PRODUCTS
create table if not exists "watchedProducts" (
  id bigserial primary key,
  "userId" text default '',
  "productId" integer default 0,
  "addedAt" bigint default 0
);

-- REFERRALS
create table if not exists referrals (
  code text primary key,
  "userId" text default '',
  name text default '',
  used boolean default false,
  "usedBy" text default '',
  "usedAt" bigint
);

-- COUPON USAGE
create table if not exists "couponUsage" (
  id bigserial primary key,
  code text default '',
  "userId" text default '',
  phone text default '',
  "orderId" text default '',
  date text default '',
  discount numeric default 0
);

-- REVIEWS
create table if not exists reviews (
  id text primary key,
  "userId" text default '',
  "userName" text default '',
  "productId" integer default 0,
  rating integer default 5,
  comment text default '',
  image text default '',
  date text default ''
);

-- TICKETS
create table if not exists tickets (
  id text primary key,
  "userId" text default '',
  "userName" text default '',
  subject text default '',
  status text default 'open',
  messages jsonb default '[]'::jsonb,
  date text default ''
);

-- RECURRING ORDERS
create table if not exists "recurringOrders" (
  id text primary key,
  "userId" text default '',
  frequency text default '',
  items jsonb default '[]'::jsonb,
  address text default '',
  total numeric default 0,
  "nextDate" text default '',
  active boolean default true,
  created text default ''
);

-- POINTS HISTORY
create table if not exists "pointsHistory" (
  id bigserial primary key,
  "userId" text default '',
  amount integer default 0,
  type text default '',
  note text default '',
  date text default ''
);

-- STOCK LOG
create table if not exists "stockLog" (
  id bigserial primary key,
  "productId" integer default 0,
  "productName" text default '',
  "oldStock" integer default 0,
  "newStock" integer default 0,
  diff integer default 0,
  reason text default '',
  time bigint default 0
);

-- SALES GOALS
create table if not exists "salesGoals" (
  id integer primary key default 1,
  daily numeric default 500000,
  weekly numeric default 3000000,
  monthly numeric default 12000000
);

-- DELIVERY PERSONS
create table if not exists "deliveryPersons" (
  id text primary key,
  name text default '',
  phone text unique,
  password text default '',
  active boolean default true,
  "createdAt" text default ''
);

-- INDEXES
create index if not exists idx_orders_user on orders ("userId");
create index if not exists idx_orders_status on orders (status);
create index if not exists idx_orders_date on orders (date);
create index if not exists idx_products_cat on products (cat);
create index if not exists idx_users_phone on users (phone);
create index if not exists idx_reviews_product on reviews ("productId");
create index if not exists idx_tickets_user on tickets ("userId");
create index if not exists idx_stocklog_time on "stockLog" (time);
