-- Collection: cards a collector holds (not for sale yet), valued every night, with alerts
-- when an item reaches its target price or growth %.

create table if not exists public.collection_items (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  created_at        timestamptz not null default now(),
  -- the scan
  photo_path        text,                    -- snap-photos/<user_id>/collection/...
  photo_crop        jsonb,                   -- this card's box on a binder-page photo
  source            text not null default 'single' check (source in ('single', 'page', 'manual')),
  extraction        jsonb,                   -- what the AI read
  -- the card
  game              text,
  card_name         text,
  set_name          text,
  collector_number  text,
  rarity            text,
  finish            text,
  variant           text,
  language          text,
  condition         text default 'NM',
  graded            boolean not null default false,
  grader            text,
  grade             text,
  quantity          integer not null default 1 check (quantity > 0),
  catalog_source    text,
  catalog_id        text,
  catalog_name      text,
  catalog_set       text,
  catalog_number    text,
  catalog_image_url text,
  catalog_url       text,
  flags             text[] not null default '{}',
  -- value
  market_price      numeric(12, 2),          -- per card
  market_source     text,                    -- tcgplayer | ebay_median | manual
  market_key        text,                    -- which price (rarity, edition, finish...)
  market_at         timestamptz,
  value_at_add      numeric(12, 2),          -- per card, the day it was scanned
  cost              numeric(12, 2),          -- per card, what was paid (optional)
  -- alerts
  target_price      numeric(12, 2),          -- per card; alert at or above
  target_pct        numeric(7, 2),           -- growth %; overrides the collection default
  alert_state       text not null default 'none' check (alert_state in ('none', 'active', 'dismissed')),
  alert_reason      text,
  alert_at          timestamptz,
  -- what happened to it
  status            text not null default 'held' check (status in ('held', 'listing', 'removed')),
  snap_item_id      uuid,
  notes             text
);
create index if not exists collection_items_user on public.collection_items (user_id, status);

-- One price per item per day, for the value history.
create table if not exists public.collection_prices (
  item_id  uuid not null references public.collection_items(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  price    numeric(12, 2) not null,
  source   text,
  primary key (item_id, day)
);
create index if not exists collection_prices_user on public.collection_prices (user_id, day);

alter table public.collection_items enable row level security;
alter table public.collection_prices enable row level security;
create policy "collection items: owner" on public.collection_items for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "collection prices: owner reads" on public.collection_prices for select
  using ((select auth.uid()) = user_id);
