-- Price change log for the Repricer. One row per attempted price edit (applied or failed).
-- Depends on auth.users only; ebay_listings comes from the seller sign-in migration.
create table if not exists public.price_changes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id     text not null,
  sku         text,
  old_price   numeric(10, 2),
  new_price   numeric(10, 2) not null,
  applied     boolean not null default false,
  error       text,
  reason      text,
  created_at  timestamptz not null default now()
);

create index if not exists price_changes_user_item_idx on public.price_changes (user_id, item_id, created_at desc);

alter table public.price_changes enable row level security;

create policy "own price changes are readable"
  on public.price_changes for select
  using (user_id = auth.uid());

-- Inserts come from the seller-reprice function using the service role, so no insert policy for clients.
