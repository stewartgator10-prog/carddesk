-- Snap-to-List (phase 1): card photo queue, AI usage/cost log, model trial results, photo storage.
-- Additive only. Server functions write identification results and usage with the service role;
-- the browser reads its own rows and edits its own queue under RLS.

-- ---------- queue of photographed cards ----------
create table if not exists public.snap_items (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  batch_id           text,
  status             text not null default 'uploaded'
                       check (status in ('uploaded', 'identifying', 'ready', 'needs_review', 'failed', 'approved', 'discarded', 'listed')),
  photo_path         text not null,          -- snap-photos/<user_id>/... front
  back_photo_path    text,
  model              text,                   -- Claude model that identified it
  extraction         jsonb,                  -- the model's raw structured read
  confidence         numeric,
  game               text,
  card_name          text,
  set_name           text,
  set_code           text,
  collector_number   text,
  finish             text,
  variant            text,
  language           text,
  condition          text not null default 'NM',
  misprint_flag      boolean not null default false,  -- AI saw something that may be a misprint
  misprint_notes     text,
  misprint_confirmed boolean not null default false,  -- set only by the seller
  catalog_source     text,                   -- tcgdex | scryfall
  catalog_id         text,
  catalog_name       text,
  catalog_set        text,
  catalog_number     text,
  catalog_image_url  text,
  catalog_url        text,
  match_level        text,                   -- exact | number | name | none
  market_price       numeric(12, 2),
  price_source       text,
  suggested_price    numeric(12, 2),
  price              numeric(12, 2),
  title              text,
  cost_basis         numeric(12, 2),
  duplicate_item_id  text,                   -- an active eBay listing that looks like the same card
  review_reasons     text[] not null default '{}',
  error              text,
  identified_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists snap_items_user_idx on public.snap_items (user_id, status, created_at desc);

-- ---------- every paid AI call, with its estimated cost ----------
create table if not exists public.api_usage (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  provider            text not null default 'anthropic',
  model               text not null,
  purpose             text not null,            -- snap_identify | model_trial
  snap_item_id        uuid references public.snap_items(id) on delete set null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  cost_usd            numeric(12, 6) not null default 0,
  latency_ms          integer,
  ok                  boolean not null default true,
  error               text,
  request_id          text
);
create index if not exists api_usage_user_idx on public.api_usage (user_id, created_at desc);

-- ---------- head-to-head model trial on the seller's own listings ----------
create table if not exists public.model_trial_results (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  trial_id        text not null,
  created_at      timestamptz not null default now(),
  model           text not null,
  item_id         text not null,            -- eBay listing whose photo and title are the test case
  expected_title  text,
  listed_price    numeric(12, 2),
  image_url       text,
  extraction      jsonb,
  catalog_source  text,
  catalog_id      text,
  catalog_name    text,
  catalog_number  text,
  market_price    numeric(12, 2),
  name_ok         boolean,
  number_ok       boolean,                  -- null when the listing title has no card number
  set_ok          boolean,
  catalog_ok      boolean,
  correct         boolean,
  latency_ms      integer,
  cost_usd        numeric(12, 6),
  input_tokens    integer,
  output_tokens   integer,
  error           text,
  unique (user_id, trial_id, model, item_id)
);
create index if not exists model_trial_results_user_idx on public.model_trial_results (user_id, trial_id);

-- ---------- triggers + RLS ----------
drop trigger if exists snap_items_updated_at on public.snap_items;
create trigger snap_items_updated_at before update on public.snap_items
  for each row execute function public.set_updated_at();

alter table public.snap_items enable row level security;
alter table public.api_usage enable row level security;
alter table public.model_trial_results enable row level security;

drop policy if exists snap_items_select_own on public.snap_items;
drop policy if exists snap_items_insert_own on public.snap_items;
drop policy if exists snap_items_update_own on public.snap_items;
drop policy if exists snap_items_delete_own on public.snap_items;
create policy snap_items_select_own on public.snap_items for select to authenticated using (user_id = (select auth.uid()));
create policy snap_items_insert_own on public.snap_items for insert to authenticated with check (user_id = (select auth.uid()));
create policy snap_items_update_own on public.snap_items for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy snap_items_delete_own on public.snap_items for delete to authenticated using (user_id = (select auth.uid()));

-- Usage and trial rows are written only by server functions (service role); owners can read them.
drop policy if exists api_usage_select_own on public.api_usage;
create policy api_usage_select_own on public.api_usage for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists model_trial_results_select_own on public.model_trial_results;
create policy model_trial_results_select_own on public.model_trial_results for select to authenticated using (user_id = (select auth.uid()));

-- ---------- private photo bucket: each user writes and reads only <their id>/... ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snap-photos', 'snap-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists snap_photos_insert_own on storage.objects;
drop policy if exists snap_photos_select_own on storage.objects;
drop policy if exists snap_photos_delete_own on storage.objects;
create policy snap_photos_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'snap-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy snap_photos_select_own on storage.objects for select to authenticated
  using (bucket_id = 'snap-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy snap_photos_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'snap-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
