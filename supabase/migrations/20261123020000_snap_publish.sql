-- Snap to List phase 2: publish approved cards to eBay.
-- Additive only.

-- The seller's listing setup learned from one of their own listings (category, condition codes,
-- item specifics, location, business policies, Best Offer %). Server-only, like the tokens.
alter table public.ebay_accounts add column if not exists listing_templates jsonb;

alter table public.snap_items add column if not exists publish_state text
  check (publish_state in ('checking', 'checked', 'check_failed', 'publishing', 'failed', 'listed'));
alter table public.snap_items add column if not exists publish_check jsonb;      -- fees, warnings, errors, what was checked
alter table public.snap_items add column if not exists ebay_picture_urls text[];  -- eBay-hosted copies of the photos
alter table public.snap_items add column if not exists sku text;
alter table public.snap_items add column if not exists ebay_item_id text;
alter table public.snap_items add column if not exists ebay_url text;
alter table public.snap_items add column if not exists listed_at timestamptz;
alter table public.snap_items add column if not exists publish_error text;
