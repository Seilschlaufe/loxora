-- Lexora: run once in Supabase SQL Editor, or with `supabase db push`.
begin;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  content text not null check (char_length(content) between 1 and 100000),
  language text not null check (language in ('de','en','es')),
  created_at timestamptz not null default now(),
  unique(owner_id,id)
);
create index documents_owner_date on public.documents(owner_id,created_at desc);

create table public.vocabulary_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid,
  analysis jsonb not null check (jsonb_typeof(analysis)='object' and octet_length(analysis::text)<=65536),
  demo boolean not null default false,
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 128),
  created_at timestamptz not null default now(),
  foreign key(owner_id,document_id) references public.documents(owner_id,id) on delete set null (document_id),
  unique(owner_id,dedupe_key)
);
create index vocabulary_owner_date on public.vocabulary_entries(owner_id,created_at desc);
create index vocabulary_document on public.vocabulary_entries(owner_id,document_id);
create index vocabulary_language on public.vocabulary_entries(owner_id,(analysis->>'language'));

create table public.reading_progress (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid not null,
  position integer not null default 0 check (position between 0 and 10000000),
  updated_at timestamptz not null default now(),
  primary key(owner_id,document_id),
  foreign key(owner_id,document_id) references public.documents(owner_id,id) on delete cascade
);

create table public.analysis_cache (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid,
  cache_key text not null check (cache_key ~ '^[a-f0-9]{64}$'),
  analysis jsonb not null check (jsonb_typeof(analysis)='object' and octet_length(analysis::text)<=65536),
  created_at timestamptz not null default now(),
  primary key(owner_id,cache_key),
  foreign key(owner_id,document_id) references public.documents(owner_id,id) on delete cascade
);
create index analysis_cache_document on public.analysis_cache(owner_id,document_id);

create table public.user_preferences (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  theme text not null default 'light' check (theme in ('light','dark','system')),
  font_size integer not null default 20 check (font_size between 16 and 32),
  updated_at timestamptz not null default now()
);

create table public.analysis_leases (
  owner_id uuid not null references auth.users(id) on delete cascade,
  cache_key text not null check (cache_key ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  primary key(owner_id,cache_key)
);

-- Client sessions use the anon/publishable key plus user JWT. No service-role key.
alter table public.documents enable row level security;
alter table public.vocabulary_entries enable row level security;
alter table public.reading_progress enable row level security;
alter table public.analysis_cache enable row level security;
alter table public.user_preferences enable row level security;
alter table public.analysis_leases enable row level security;

create policy documents_owner on public.documents for all to authenticated
  using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy vocabulary_owner on public.vocabulary_entries for all to authenticated
  using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy progress_owner on public.reading_progress for all to authenticated
  using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy cache_owner on public.analysis_cache for all to authenticated
  using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy preferences_owner on public.user_preferences for all to authenticated
  using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy leases_read_owner on public.analysis_leases for select to authenticated
  using ((select auth.uid())=owner_id);
create policy leases_delete_owner on public.analysis_leases for delete to authenticated
  using ((select auth.uid())=owner_id);

-- Remove Supabase default ALL grants first: TRUNCATE bypasses row-level security.
revoke all on public.documents,public.vocabulary_entries,public.reading_progress,
 public.analysis_cache,public.user_preferences,public.analysis_leases from public,anon,authenticated;
grant select,insert,update,delete on public.documents,public.vocabulary_entries,
 public.reading_progress,public.analysis_cache,public.user_preferences to authenticated;
grant select,delete on public.analysis_leases to authenticated;
revoke all on public.documents,public.vocabulary_entries,public.reading_progress,
 public.analysis_cache,public.user_preferences,public.analysis_leases from anon;
-- Supabase may grant default public table privileges. Only RPC may mint leases.
revoke insert,update,truncate,references,trigger on public.analysis_leases from authenticated;

create schema lexora_private;
revoke all on schema lexora_private from public,anon,authenticated;
create table lexora_private.analysis_requests (
  owner_id uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default clock_timestamp()
);
create index analysis_requests_owner_date on lexora_private.analysis_requests(owner_id,requested_at);
revoke all on lexora_private.analysis_requests from public,anon,authenticated;

create function public.claim_analysis(p_key text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  moment timestamptz := clock_timestamp();
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_key is null or p_key !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid analysis key' using errcode='22023';
  end if;
  -- Serialize this user's requests across all server processes.
  perform pg_advisory_xact_lock(hashtextextended(caller::text,0));
  delete from public.analysis_leases where owner_id=caller and expires_at<=moment;
  if exists(select 1 from public.analysis_leases where owner_id=caller and cache_key=p_key) then
    return 'busy';
  end if;
  delete from lexora_private.analysis_requests where owner_id=caller and requested_at<=moment-interval '1 minute';
  if (select count(*) from lexora_private.analysis_requests where owner_id=caller)>=20 then
    return 'limited';
  end if;
  insert into lexora_private.analysis_requests(owner_id,requested_at) values(caller,moment);
  insert into public.analysis_leases(owner_id,cache_key,expires_at) values(caller,p_key,moment+interval '90 seconds');
  return 'ok';
end;
$$;
revoke all on function public.claim_analysis(text) from public,anon;
grant execute on function public.claim_analysis(text) to authenticated;

create function public.delete_my_data() returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  delete from public.vocabulary_entries where owner_id=caller;
  delete from public.documents where owner_id=caller;
  delete from public.reading_progress where owner_id=caller;
  delete from public.analysis_cache where owner_id=caller;
  delete from public.user_preferences where owner_id=caller;
  delete from public.analysis_leases where owner_id=caller;
  -- Keep only the last minute's technical quota metadata: deleting content must
  -- not reset the paid-request limit. It contains no document text or analysis.
  delete from lexora_private.analysis_requests where owner_id=caller
    and requested_at<=clock_timestamp()-interval '1 minute';
end;
$$;
revoke all on function public.delete_my_data() from public,anon;
grant execute on function public.delete_my_data() to authenticated;

commit;
