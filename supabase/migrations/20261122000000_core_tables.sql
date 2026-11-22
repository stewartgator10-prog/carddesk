-- CardDesk core tables: inventory, watchlist, comps, settings.
-- Every row belongs to one signed-in user and row-level security keeps it that way.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- inventory ----------
create table public.inventory (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_name      text not null,
  game           text,
  set_name       text,
  condition      text,
  purchase_price numeric(12,2),
  shipping_in    numeric(12,2) default 0,
  cost_basis     numeric(12,2),
  current_fmv    numeric(12,2),
  liquidity      text,
  status         text not null default 'In Stock' check (status in ('In Stock', 'Sold')),
  acquired_at    date,
  sold_at        date,
  sale_price     numeric(12,2),
  sale_channel   text,
  shipping_out   numeric(12,2),
  ebay_item_id   text,
  sku            text,
  legacy_id      bigint,          -- id from the old localStorage/JSON backup, used to dedupe imports
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index inventory_user_idx on public.inventory (user_id, status);
create unique index inventory_user_legacy_idx on public.inventory (user_id, legacy_id);  -- NULLs never collide, so new rows are unaffected

-- ---------- watchlist ----------
create table public.watchlist (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_name   text not null,
  game        text,
  set_name    text,
  condition   text,
  target_fmv  numeric(12,2),
  max_buy     numeric(12,2),
  liquidity   text,
  added_at    timestamptz not null default now(),
  legacy_id   bigint,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index watchlist_user_idx on public.watchlist (user_id);
create unique index watchlist_user_legacy_idx on public.watchlist (user_id, legacy_id);  -- NULLs never collide, so new rows are unaffected

-- ---------- comps (sold comparables) ----------
create table public.comps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_name   text not null,
  game        text,
  set_name    text,
  condition   text,
  sale_price  numeric(12,2) not null,
  source      text,
  sold_on     date,
  legacy_id   bigint,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index comps_user_idx on public.comps (user_id, card_name);
create unique index comps_user_legacy_idx on public.comps (user_id, legacy_id);  -- NULLs never collide, so new rows are unaffected

-- ---------- settings (one row per user; fee profile etc.) ----------
create table public.settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------- triggers + RLS ----------
do $$
declare t text;
begin
  foreach t in array array['inventory', 'watchlist', 'comps', 'settings'] loop
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "%s_select_own" on public.%I for select to authenticated using (user_id = (select auth.uid()))', t, t);
    execute format('create policy "%s_insert_own" on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t, t);
    execute format('create policy "%s_update_own" on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t, t);
    execute format('create policy "%s_delete_own" on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t, t);
  end loop;
end $$;
