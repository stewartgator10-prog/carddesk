-- Tyche Cards plans. One row per user; written only by the server (Stripe webhook, comps).
-- Missing row = Free. Plan limits are enforced only on the Tyche Cards site (BILLING_ENABLED),
-- so the founder site (jaxspic) behaves exactly as before.
create table if not exists public.subscriptions (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  plan                    text not null default 'free' check (plan in ('free', 'basic', 'pro', 'elite')),
  status                  text not null default 'active',     -- Stripe status, or 'comped'
  billing_interval        text check (billing_interval in ('month', 'year')),
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  comped                  boolean not null default false,     -- free of charge on this plan (founders)
  updated_at              timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy "read own plan" on public.subscriptions for select using (auth.uid() = user_id);

-- Founders: Elite, free.
insert into public.subscriptions (user_id, plan, status, comped)
select id, 'elite', 'comped', true from auth.users where lower(email) in ('jackson.batz@gmail.com', 'stewartgator10@gmail.com')
on conflict (user_id) do update set plan = 'elite', status = 'comped', comped = true, updated_at = now();
