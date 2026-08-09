-- =====================================================
-- FIX: add missing products columns (category, description, tags)
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query -> Run
-- =====================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS category text default '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS description text default '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS tags text default '';