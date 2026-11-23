-- Automatic comps: per active eBay listing, what the card is (AI-read title), its TCGplayer
-- market price (catalog) and the live eBay competition (cheapest comparable Buy It Now listings).
-- Written by server functions (on demand and nightly); the owner can read their rows.
create table if not exists public.listing_market (
  user_id           uuid not null references auth.users(id) on delete cascade,
  item_id           text not null,
  title_snapshot    text,                 -- the title that was read; a renamed listing is read again
  parsed            jsonb,                -- { is_single_card, game, card_name, collector_number, set_name, language, finish, variant, graded, grader, grade, condition }
  parsed_at         timestamptz,
  parse_model       text,
  catalog_source    text,
  catalog_id        text,
  catalog_name      text,
  catalog_set       text,
  catalog_number    text,
  match_level       text,
  market_price      numeric(12, 2),
  market_price_key  text,
  market_at         timestamptz,
  comp_query        text,
  comp_low          numeric(12, 2),       -- cheapest comparable listing, price + shipping
  comp_median       numeric(12, 2),
  comp_count        integer,
  comp_items        jsonb,                -- up to 5: { title, price, shipping, total, url, seller, condition }
  comp_at           timestamptz,
  error             text,
  updated_at        timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.listing_market enable row level security;
drop policy if exists listing_market_select_own on public.listing_market;
create policy listing_market_select_own on public.listing_market for select to authenticated using (user_id = (select auth.uid()));
