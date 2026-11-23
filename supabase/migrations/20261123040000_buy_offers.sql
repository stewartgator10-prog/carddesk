-- Buy-offer mode: photograph a collection, value each card, make a tiered offer;
-- on accept the deal becomes a purchase and the cards go to the Snap to List queue.
-- Additive only.

create table if not exists public.buy_offers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text,
  status        text not null default 'draft' check (status in ('draft', 'accepted', 'declined')),
  tiers         jsonb,                    -- offer rules used (snapshot at accept)
  total_market  numeric(12, 2),
  total_offer   numeric(12, 2),
  final_offer   numeric(12, 2),           -- what was actually paid
  purchase_id   uuid references public.purchases(id) on delete set null,
  notes         text,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists buy_offers_user_idx on public.buy_offers (user_id, created_at desc);

create table if not exists public.buy_offer_items (
  id                uuid primary key default gen_random_uuid(),
  offer_id          uuid not null references public.buy_offers(id) on delete cascade,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  photo_path        text not null,          -- snap-photos/<user>/...: the page or single-card photo
  source            text not null check (source in ('page', 'single')),
  position          integer,                -- order on a page, left to right, top to bottom
  box               jsonb,                  -- where the card is in a page photo: { x, y, w, h } as 0-1 fractions
  extraction        jsonb,
  confidence        numeric,
  game              text,
  card_name         text,
  set_name          text,
  collector_number  text,
  language          text,
  finish            text,
  condition         text not null default 'NM',
  graded            boolean not null default false,
  catalog_source    text,
  catalog_id        text,
  catalog_name      text,
  catalog_set       text,
  catalog_number    text,
  catalog_image_url text,
  market_price      numeric(12, 2),
  market_source     text,                   -- tcgplayer | ebay_median
  market_override   numeric(12, 2),
  offer_override    numeric(12, 2),
  included          boolean not null default true,
  flags             text[] not null default '{}',
  snap_item_id      uuid references public.snap_items(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists buy_offer_items_offer_idx on public.buy_offer_items (offer_id, position);

-- Snap items created from a page photo show only their part of the photo until replaced.
alter table public.snap_items add column if not exists photo_crop jsonb;

drop trigger if exists buy_offers_updated_at on public.buy_offers;
create trigger buy_offers_updated_at before update on public.buy_offers for each row execute function public.set_updated_at();

alter table public.buy_offers enable row level security;
alter table public.buy_offer_items enable row level security;
do $$
declare t text;
begin
  foreach t in array array['buy_offers', 'buy_offer_items'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner', t);
    execute format('create policy %I on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t || '_owner', t);
  end loop;
end $$;
