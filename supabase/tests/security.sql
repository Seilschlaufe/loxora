\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('10000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
insert into public.documents(id,title,content,language) values('10000000-0000-4000-8000-000000000011','A','Er beschloss zu lesen.','de');
insert into public.vocabulary_entries(id,document_id,analysis,dedupe_key) values('10000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000011','{"language":"de"}','a');
insert into public.reading_progress(document_id,position) values('10000000-0000-4000-8000-000000000011',8);
insert into public.user_preferences(theme,font_size) values('dark',22);
insert into public.analysis_cache(cache_key,analysis) values(repeat('a',64),'{"owner":"a"}');

select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
insert into public.documents(id,title,content,language) values('20000000-0000-4000-8000-000000000021','B','She gave up.','en');
insert into public.vocabulary_entries(id,document_id,analysis,dedupe_key) values('20000000-0000-4000-8000-000000000022','20000000-0000-4000-8000-000000000021','{"language":"en"}','b');
insert into public.analysis_cache(cache_key,analysis) values(repeat('a',64),'{"owner":"b"}');

do $$ begin
 if (select count(*) from public.documents)<>1 then raise exception 'RLS document select'; end if;
 if (select count(*) from public.vocabulary_entries)<>1 then raise exception 'RLS vocabulary select'; end if;
 if (select count(*) from public.reading_progress)<>0 then raise exception 'RLS progress select'; end if;
 if (select count(*) from public.user_preferences)<>0 then raise exception 'RLS preferences select'; end if;
 if (select analysis->>'owner' from public.analysis_cache where cache_key=repeat('a',64))<>'b' then raise exception 'RLS cache select'; end if;
 update public.documents set title='stolen' where id='10000000-0000-4000-8000-000000000011';
 if found then raise exception 'RLS update foreign document'; end if;
 delete from public.vocabulary_entries where id='10000000-0000-4000-8000-000000000012';
 if found then raise exception 'RLS delete foreign vocabulary'; end if;
 begin
  insert into public.documents(owner_id,title,content,language) values('10000000-0000-4000-8000-000000000001','spoof','x','de');
  raise exception 'spoofed owner accepted';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.vocabulary_entries(document_id,analysis,dedupe_key) values('10000000-0000-4000-8000-000000000011','{}','cross-owner');
  raise exception 'foreign document reference accepted';
 exception when foreign_key_violation then null; end;
 begin
  truncate table public.documents cascade;
  raise exception 'RLS bypass via TRUNCATE accepted';
 exception when insufficient_privilege then null; end;
 begin
  truncate table public.analysis_cache;
  raise exception 'RLS cache bypass via TRUNCATE accepted';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.analysis_leases(owner_id,cache_key,expires_at) values(auth.uid(),repeat('b',64),now());
  raise exception 'lease direct insert accepted';
 exception when insufficient_privilege then null; end;
 begin
  delete from lexora_private.analysis_requests;
  raise exception 'private quota access accepted';
 exception when insufficient_privilege then null; end;
end $$;

-- Quota and leases work across statements and cannot be reset by releasing a lease.
do $$ declare i integer; result text; begin
 if public.claim_analysis(repeat('b',64))<>'ok' then raise exception 'initial lease'; end if;
 if public.claim_analysis(repeat('b',64))<>'busy' then raise exception 'concurrent lease'; end if;
 delete from public.analysis_leases where cache_key=repeat('b',64);
 for i in 2..20 loop
  result:=public.claim_analysis(lpad(to_hex(i),64,'0'));
  if result<>'ok' then raise exception 'quota prematurely exhausted at %: %',i,result; end if;
 end loop;
 if public.claim_analysis(repeat('c',64))<>'limited' then raise exception 'quota bypass'; end if;
end $$;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ begin
 if (select title from public.documents limit 1)<>'A' then raise exception 'foreign update modified data'; end if;
 if public.claim_analysis(repeat('b',64))<>'ok' then raise exception 'quota not isolated per user'; end if;
 -- Repeated save cannot create accidental exact duplicates.
 begin
  insert into public.vocabulary_entries(document_id,analysis,dedupe_key) values('10000000-0000-4000-8000-000000000011','{}','a');
  raise exception 'duplicate save accepted';
 exception when unique_violation then null; end;
end $$;
insert into public.analysis_cache(cache_key,document_id,analysis) values(repeat('d',64),'10000000-0000-4000-8000-000000000011','{}');
delete from public.documents where id='10000000-0000-4000-8000-000000000011';
do $$ begin
 if (select count(*) from public.vocabulary_entries)<>1 or (select document_id from public.vocabulary_entries limit 1) is not null then raise exception 'document deletion lost saved vocabulary'; end if;
 if (select count(*) from public.reading_progress)<>0 then raise exception 'document deletion left orphan progress'; end if;
 if exists(select 1 from public.analysis_cache where cache_key=repeat('d',64)) then raise exception 'document deletion left cache'; end if;
 begin
  insert into public.analysis_cache(cache_key,document_id,analysis) values(repeat('e',64),'10000000-0000-4000-8000-000000000011','{}');
  raise exception 'late inflight cache resurrected deleted data';
 exception when foreign_key_violation then null; end;
end $$;
select public.delete_my_data();
do $$ declare i integer; begin
 if exists(select 1 from public.vocabulary_entries) or exists(select 1 from public.analysis_cache) or exists(select 1 from public.user_preferences) or exists(select 1 from public.analysis_leases) then raise exception 'delete_my_data incomplete'; end if;
 -- A claimed once before deletion: exactly 19 attempts remain, not 20.
 for i in 1..19 loop
  if public.claim_analysis(lpad(to_hex(i+100),64,'0'))<>'ok' then raise exception 'quota retention prematurely limited'; end if;
 end loop;
 if public.claim_analysis(repeat('f',64))<>'limited' then raise exception 'delete_my_data reset rate limit'; end if;
end $$;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
do $$ begin
 if (select count(*) from public.documents)<>1 or (select count(*) from public.vocabulary_entries)<>1 then raise exception 'delete_my_data damaged another user'; end if;
end $$;
set local role anon;
do $$ begin
 begin
  perform public.claim_analysis(repeat('c',64));
  raise exception 'anon analysis accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.delete_my_data();
  raise exception 'anon deletion accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform count(*) from public.documents;
  raise exception 'anon document access accepted';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
\echo 'PASS: RLS CRUD isolation, relational ownership, cache isolation, lease exclusion, per-user quota, deduplication, deletion and anonymous access'
