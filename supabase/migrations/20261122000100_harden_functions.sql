-- Pin search_path on the updated_at trigger function (Supabase security advisor 0011).
alter function public.set_updated_at() set search_path = '';
-- rls_auto_enable (created by Supabase on newer projects) is an event-trigger helper;
-- API roles never need to call it directly.
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
  end if;
end $$;
