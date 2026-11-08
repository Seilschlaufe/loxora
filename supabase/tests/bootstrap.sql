-- Minimal Supabase auth contract for isolated PostgreSQL policy tests.
-- This is test infrastructure, never run on an actual Supabase project.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;

-- Supabase grants broad table privileges by default; migration must narrow them.
alter default privileges for role postgres in schema public grant all on tables to anon,authenticated;
