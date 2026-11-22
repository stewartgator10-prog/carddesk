-- CardDesk: eBay seller connection + active listings sync
-- Depends on Supabase Auth (auth.users), added by the login/core-tables migration.
--
-- RLS: the token tables have RLS ON and NO policies, so only the service-role
-- key (used server-side in Netlify Functions) can touch them. The browser can
-- read its own listings snapshot.

-- One row per user: their connected eBay seller account + OAuth tokens.
create table if not exists public.ebay_accounts (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null unique references auth.users(id) on delete cascade,
  ebay_user_id              text,                 -- from commerce.identity
  ebay_username             text,
  access_token              text not null,
  access_token_expires_at   timestamptz not null,
  refresh_token             text not null,
  refresh_token_expires_at  timestamptz,
  scopes                    text,
  last_synced_at            timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Short-lived OAuth "state" values that tie the eBay callback to the user
-- who clicked Connect (CSRF protection). Rows older than 15 min are ignored.
create table if not exists public.ebay_oauth_states (
  state       text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Snapshot of the seller's listings, refreshed on each sync.
create table if not exists public.ebay_listings (
  account_id          uuid not null references public.ebay_accounts(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  item_id             text not null,      -- eBay legacy ItemID
  title               text,
  sku                 text,
  price               numeric(12,2),
  currency            text,
  quantity            integer,            -- total quantity listed
  quantity_available  integer,
  quantity_sold       integer,
  watch_count         integer,
  listing_type        text,               -- FixedPriceItem / Chinese (auction)
  start_time          timestamptz,
  end_time            timestamptz,
  view_url            text,
  image_url           text,
  status              text not null default 'Active',  -- 'Active', or 'Ended' when no longer returned by eBay
  synced_at           timestamptz not null default now(),
  raw                 jsonb,
  primary key (account_id, item_id)
);

create index if not exists ebay_listings_user_idx on public.ebay_listings(user_id);

alter table public.ebay_accounts     enable row level security;
alter table public.ebay_oauth_states enable row level security;
alter table public.ebay_listings     enable row level security;

drop policy if exists "owner can read own listings" on public.ebay_listings;
create policy "owner can read own listings" on public.ebay_listings
  for select using (user_id = auth.uid());
