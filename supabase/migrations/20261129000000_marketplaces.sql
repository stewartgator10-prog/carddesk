-- Cross-listing foundation: one place for every marketplace a seller connects, where each card is
-- listed, the sales we have handled (so "sell once" ends the other listings exactly once), and a
-- stock count per card. Additive only. eBay stays in ebay_accounts; its listings are backfilled here.

-- Marketplace connections other than eBay (Whatnot first; Shopify and TCGplayer later).
-- Tokens are sealed by netlify/lib/secret-box.js before they are stored. RLS on, NO policies:
-- only the service role (Netlify Functions) can read or write this table, like ebay_accounts.
create table if not exists public.marketplace_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  marketplace        text not null check (marketplace in ('whatnot', 'shopify', 'tcgplayer')),
  auth_kind          text not null check (auth_kind in ('personal_token', 'oauth')),
  access_token_enc   text not null,
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  scopes             text[],
  external_user_id   text,
  external_username  text,
  status             text not null default 'connected' check (status in ('connected', 'reconnect')),
  last_error         text,
  sales_checked_at   timestamptz,
  settings           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, marketplace)
);
alter table public.marketplace_accounts enable row level security;

-- Where each card is listed. The seller can read their own rows; writes go through functions.
create table if not exists public.marketplace_listings (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  snap_item_id         uuid references public.snap_items(id) on delete set null,
  inventory_id         uuid references public.inventory(id) on delete set null,
  marketplace          text not null check (marketplace in ('ebay', 'whatnot', 'shopify', 'tcgplayer')),
  external_id          text,            -- eBay ItemID / Whatnot product id
  external_variant_id  text,
  external_listing_id  text,
  url                  text,
  price                numeric(12,2),
  currency             text not null default 'USD',
  quantity             integer,
  status               text not null default 'active' check (status in ('active', 'ending', 'ended', 'sold', 'failed')),
  ended_reason         text check (ended_reason in ('seller', 'sold_elsewhere', 'sold_out', 'not_found', 'disconnected')),
  last_error           text,
  listed_at            timestamptz,
  ended_at             timestamptz,
  sold_at              timestamptz,
  synced_at            timestamptz,
  raw                  jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists marketplace_listings_external_uq
  on public.marketplace_listings (user_id, marketplace, external_id);
-- One live listing per card per marketplace.
create unique index if not exists marketplace_listings_one_live_uq
  on public.marketplace_listings (snap_item_id, marketplace) where status in ('active', 'ending');
create index if not exists marketplace_listings_user_status_idx on public.marketplace_listings (user_id, status);
alter table public.marketplace_listings enable row level security;
drop policy if exists "owner can read own marketplace listings" on public.marketplace_listings;
create policy "owner can read own marketplace listings" on public.marketplace_listings
  for select using (user_id = auth.uid());

-- Every sale line we have seen, from any marketplace. Inserting with "on conflict do nothing" and
-- acting only on new rows makes the sale check safe to run twice, or from both sites at once.
create table if not exists public.marketplace_orders (
  user_id            uuid not null references auth.users(id) on delete cascade,
  marketplace        text not null,
  external_order_id  text not null,
  external_line_id   text not null,
  listing_id         uuid references public.marketplace_listings(id) on delete set null,
  snap_item_id       uuid,
  quantity           integer not null default 1,
  item_price         numeric(12,2),
  status             text,
  ordered_at         timestamptz,
  handled_at         timestamptz,
  raw                jsonb,
  created_at         timestamptz not null default now(),
  primary key (user_id, marketplace, external_order_id, external_line_id)
);
alter table public.marketplace_orders enable row level security;
drop policy if exists "owner can read own marketplace orders" on public.marketplace_orders;
create policy "owner can read own marketplace orders" on public.marketplace_orders
  for select using (user_id = auth.uid());

-- Stock per card, and what happened when it sold (the app writes the sentence from sale_note:
-- { marketplace, at, price, quantity_left, ended: [{ marketplace, ok, error }], double_sale }).
-- snap_items.status keeps its meaning: 'listed' = on eBay.
alter table public.snap_items add column if not exists quantity integer not null default 1;
do $$ begin
  alter table public.snap_items add constraint snap_items_quantity_nonneg check (quantity >= 0);
exception when duplicate_object then null; end $$;
alter table public.snap_items add column if not exists sold_out_at timestamptz;
alter table public.snap_items add column if not exists sale_note jsonb;

-- Backfill: every card listed on eBay from Snap to List gets its eBay row.
insert into public.marketplace_listings
  (user_id, snap_item_id, inventory_id, marketplace, external_id, url, price, quantity, status, ended_reason, listed_at, ended_at, synced_at)
select s.user_id, s.id,
       (select i.id from public.inventory i where i.user_id = s.user_id and i.ebay_item_id = s.ebay_item_id order by i.created_at limit 1),
       'ebay', s.ebay_item_id, coalesce(s.ebay_url, 'https://www.ebay.com/itm/' || s.ebay_item_id), s.price,
       coalesce(l.quantity_available, 1),
       case when coalesce(l.status, 'Active') = 'Active' then 'active' else 'ended' end,
       case when coalesce(l.status, 'Active') = 'Active' then null else 'not_found' end,
       coalesce(s.listed_at, now()),
       case when coalesce(l.status, 'Active') = 'Active' then null else coalesce(l.end_time, now()) end,
       now()
  from public.snap_items s
  left join public.ebay_listings l on l.user_id = s.user_id and l.item_id = s.ebay_item_id
 where s.status = 'listed' and s.ebay_item_id is not null
on conflict do nothing;
