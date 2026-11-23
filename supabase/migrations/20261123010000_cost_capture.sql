-- Cost capture: purchases (one order from one seller, possibly several cards + shipping/tax),
-- where each inventory card's cost came from, and whether a sale's profit rests on an estimate.
-- Additive only.

create table if not exists public.purchases (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  purchased_at  date not null default current_date,
  source        text,                       -- e.g. "eBay: seller123", "TCGplayer", "LGS"
  total_paid    numeric(12, 2) not null check (total_paid >= 0),  -- everything paid: cards + shipping + tax
  split_method  text not null default 'market' check (split_method in ('market', 'even')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists purchases_user_idx on public.purchases (user_id, purchased_at desc);

alter table public.inventory add column if not exists purchase_id uuid references public.purchases(id) on delete set null;
alter table public.inventory add column if not exists cost_source text
  check (cost_source in ('entered', 'purchase', 'estimated'));
create index if not exists inventory_user_item_idx on public.inventory (user_id, ebay_item_id);

alter table public.snap_items add column if not exists purchase_id uuid references public.purchases(id) on delete set null;
alter table public.snap_items add column if not exists cost_source text
  check (cost_source in ('entered', 'purchase', 'estimated'));

-- True when the cost behind this sale's profit is an estimate.
alter table public.ebay_order_lines add column if not exists cost_estimated boolean not null default false;

drop trigger if exists purchases_updated_at on public.purchases;
create trigger purchases_updated_at before update on public.purchases
  for each row execute function public.set_updated_at();

alter table public.purchases enable row level security;
drop policy if exists purchases_select_own on public.purchases;
drop policy if exists purchases_insert_own on public.purchases;
drop policy if exists purchases_update_own on public.purchases;
drop policy if exists purchases_delete_own on public.purchases;
create policy purchases_select_own on public.purchases for select to authenticated using (user_id = (select auth.uid()));
create policy purchases_insert_own on public.purchases for insert to authenticated with check (user_id = (select auth.uid()));
create policy purchases_update_own on public.purchases for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy purchases_delete_own on public.purchases for delete to authenticated using (user_id = (select auth.uid()));
