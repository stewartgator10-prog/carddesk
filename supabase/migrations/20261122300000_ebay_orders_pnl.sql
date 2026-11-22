-- eBay orders, finance transactions, and per-line P&L.
-- Depends on: 20261122000000_core_tables.sql (inventory) and the ebay_accounts
-- table from the seller sign-in work. Runs after both.

create table if not exists public.ebay_orders (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  order_id text not null,
  created_at_ebay timestamptz,
  buyer_username text,
  payment_status text,
  fulfillment_status text,
  cancel_state text,
  subtotal numeric,
  shipping_charged numeric,
  order_total numeric,
  marketplace_fee_reported numeric,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, order_id)
);

create table if not exists public.ebay_order_lines (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  line_item_id text not null,
  order_id text not null,
  legacy_item_id text,
  sku text,
  title text,
  quantity int not null default 1,
  item_price numeric,
  shipping_charged numeric,
  fulfillment_status text,
  -- matching to inventory
  inventory_id uuid references public.inventory(id) on delete set null,
  match_method text check (match_method in ('item_id', 'sku', 'title', 'manual')),
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched', 'auto', 'suggested', 'confirmed', 'ignored')),
  match_confidence numeric,
  -- computed P&L (refreshed on every sync)
  gross numeric,
  fees numeric,
  fee_source text check (fee_source in ('actual', 'order', 'estimated')),
  shipping_label numeric,
  ad_fees numeric,
  refunds numeric,
  other numeric,
  net_payout numeric,
  cost_basis numeric,
  profit numeric,
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, line_item_id),
  foreign key (user_id, order_id) references public.ebay_orders (user_id, order_id) on delete cascade
);
create index if not exists ebay_order_lines_order_idx on public.ebay_order_lines (user_id, order_id);
create index if not exists ebay_order_lines_sold_idx on public.ebay_order_lines (user_id, sold_at desc);

create table if not exists public.ebay_transactions (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  transaction_id text not null,
  transaction_type text not null,
  transaction_status text,
  transaction_date timestamptz,
  order_id text,
  fee_type text,
  amount numeric,           -- signed: + money in, - money out
  total_fee_amount numeric,
  line_fees jsonb,
  memo text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- eBay can reuse a transaction id across types (e.g. a SALE and its REFUND)
  primary key (user_id, transaction_id, transaction_type)
);
create index if not exists ebay_transactions_order_idx on public.ebay_transactions (user_id, order_id);
create index if not exists ebay_transactions_date_idx on public.ebay_transactions (user_id, transaction_date desc);

-- Link an inventory row to the eBay sale that sold it.
alter table public.inventory add column if not exists ebay_order_line_id text;
create unique index if not exists inventory_ebay_order_line_uidx
  on public.inventory (user_id, ebay_order_line_id) where ebay_order_line_id is not null;

-- Remember how far order/fee sync has got.
alter table public.ebay_accounts add column if not exists orders_synced_at timestamptz;

-- RLS: owner only.
do $$
declare t text;
begin
  foreach t in array array['ebay_orders', 'ebay_order_lines', 'ebay_transactions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_owner', t);
  end loop;
end $$;
