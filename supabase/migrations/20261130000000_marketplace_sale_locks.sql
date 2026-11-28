-- One sale check per seller at a time. Scheduled sale checks start every 5 minutes and can run for
-- longer than that; "Check for sales now" can start one too. Each check takes this lease first
-- (netlify/lib/sell-once.js takeSaleLock) and gives it back when done; a lease that runs out
-- (a check cut off by the time limit) can be taken over. Additive only.
-- RLS on, NO policies: only the service role (Netlify Functions) reads or writes it.
create table if not exists public.marketplace_sale_locks (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  holder        text not null,
  locked_until  timestamptz not null,
  updated_at    timestamptz not null default now()
);
alter table public.marketplace_sale_locks enable row level security;
