-- Personal access keys for AI apps that can't run the "Sign in with CardDesk" flow (Muse, Grok...).
-- Only a SHA-256 hash of each key is stored; the key itself is shown once, when it's created.
create table if not exists public.access_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  email         text,                      -- the owner's email when created, re-checked against ALLOWED_EMAILS on every use
  name          text not null,
  prefix        text not null,             -- first characters, so the owner can tell keys apart
  key_hash      text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists access_keys_user on public.access_keys (user_id);

alter table public.access_keys enable row level security;
-- Owners can see their keys (never the hash's source); creating and revoking go through the server.
create policy "access keys: owner reads" on public.access_keys for select
  using ((select auth.uid()) = user_id);
