-- THARA HDB - Supabase FINAL setup v3
-- Non-destructive: existing love_responses rows are kept.

create extension if not exists pgcrypto;

create table if not exists public.love_responses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  answers jsonb not null
);

-- Make older versions compatible if the table already existed.
alter table public.love_responses
  alter column id set default gen_random_uuid(),
  alter column created_at set default now();

create index if not exists love_responses_created_at_idx
on public.love_responses (created_at desc);

alter table public.love_responses enable row level security;

-- Remove old direct public policies. All app operations use RPC functions below.
drop policy if exists "public can submit love responses" on public.love_responses;
drop policy if exists "admin backend can read responses" on public.love_responses;
drop policy if exists "admin backend can delete responses" on public.love_responses;

-- Private credentials table for this small personal site.
create schema if not exists private;
create table if not exists private.app_secrets (
  key text primary key,
  value text not null
);

insert into private.app_secrets(key, value)
values
  ('admin_username', 'thara'),
  ('admin_password', 'thara2008')
on conflict (key) do update set value = excluded.value;

revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

-- 1) QUIZ SUBMIT: public visitor can only insert an answers JSON array.
create or replace function public.submit_love_response(p_answers jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  new_id uuid;
begin
  if p_answers is null
     or jsonb_typeof(p_answers) <> 'array'
     or jsonb_array_length(p_answers) < 1
     or jsonb_array_length(p_answers) > 20 then
    raise exception 'Invalid answers';
  end if;

  insert into public.love_responses(answers)
  values (p_answers)
  returning id into new_id;

  return new_id;
end;
$$;

-- 2) ADMIN READ: returns all rows only for thara / thara2008.
create or replace function public.admin_get_responses(p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
declare
  ok boolean;
  result jsonb;
begin
  select
    coalesce((select value from private.app_secrets where key='admin_username'),'') = coalesce(p_username,'')
    and
    coalesce((select value from private.app_secrets where key='admin_password'),'') = coalesce(p_password,'')
  into ok;

  if not ok then
    return jsonb_build_object('error','invalid_credentials');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'created_at', created_at,
        'answers', answers
      ) order by created_at desc
    ),
    '[]'::jsonb
  )
  into result
  from public.love_responses;

  return result;
end;
$$;

-- 3) ADMIN DELETE: deletes only the requested row after credentials check.
create or replace function public.admin_delete_response(
  p_id uuid,
  p_username text,
  p_password text
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
declare
  ok boolean;
  deleted_count integer;
begin
  select
    coalesce((select value from private.app_secrets where key='admin_username'),'') = coalesce(p_username,'')
    and
    coalesce((select value from private.app_secrets where key='admin_password'),'') = coalesce(p_password,'')
  into ok;

  if not ok then
    return false;
  end if;

  delete from public.love_responses where id = p_id;
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

-- Explicit permissions: anon/authenticated can execute only these safe RPCs.
revoke all on function public.submit_love_response(jsonb) from public;
revoke all on function public.admin_get_responses(text,text) from public;
revoke all on function public.admin_delete_response(uuid,text,text) from public;

grant usage on schema public to anon, authenticated;
grant execute on function public.submit_love_response(jsonb) to anon, authenticated;
grant execute on function public.admin_get_responses(text,text) to anon, authenticated;
grant execute on function public.admin_delete_response(uuid,text,text) to anon, authenticated;

-- Do not grant direct table SELECT/INSERT/DELETE to the browser.
revoke all on table public.love_responses from anon, authenticated;

-- Optional verification after running this script:
-- select count(*) as saved_responses from public.love_responses;
