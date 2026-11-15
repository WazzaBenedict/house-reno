-- 舊屋翻修管理 app 的資料庫結構。
-- 用法：Supabase 後台 → SQL Editor → 貼上整份 → Run。可以重複執行。

create extension if not exists pgcrypto;

-- 可以登入並看到全部資料的人（屋主和家人）
create table if not exists public.members (
  email text primary key,
  role text not null default 'member' check (role in ('owner', 'member')),
  name text not null default '',
  created_at timestamptz not null default now()
);

-- 所有翻修資料：工種、時程、預算、驗收、待辦、回報，各是一列
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  sort double precision not null default 0,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists items_kind_idx on public.items (kind);

-- 工班專屬連結：一個工種一條，不用登入就能回報
create table if not exists public.crew_links (
  token text primary key default encode(gen_random_bytes(12), 'hex'),
  trade_id uuid not null unique,
  created_at timestamptz not null default now()
);

-- 目前登入者已驗證的 email
create or replace function public.my_email() returns text
language sql stable security definer set search_path = public, auth as $$
  select lower(u.email) from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.email = public.my_email())
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.email = public.my_email() and m.role = 'owner')
$$;

-- 第一個登入的人成為屋主；之後由屋主在 app 裡加入其他人
create or replace function public.claim_owner() returns boolean
language plpgsql security definer set search_path = public as $$
declare e text := public.my_email();
begin
  if e is null then return false; end if;
  lock table public.members in exclusive mode;
  if exists (select 1 from public.members) then return false; end if;
  insert into public.members (email, role) values (e, 'owner');
  return true;
end $$;

create or replace function public.items_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(public.my_email(), 'crew');
  return new;
end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
  for each row execute function public.items_touch();

alter table public.members enable row level security;
alter table public.items enable row level security;
alter table public.crew_links enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (public.is_member());
drop policy if exists members_insert on public.members;
create policy members_insert on public.members for insert to authenticated with check (public.is_owner() and role = 'member');
drop policy if exists members_delete on public.members;
create policy members_delete on public.members for delete to authenticated using (public.is_owner() and role = 'member');

drop policy if exists items_all on public.items;
create policy items_all on public.items for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists crew_links_all on public.crew_links;
create policy crew_links_all on public.crew_links for all to authenticated using (public.is_member()) with check (public.is_member());

-- 工班用連結開啟：只拿得到自己工種的名稱和回報
create or replace function public.crew_open(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.items;
begin
  select i.* into t from public.crew_links l join public.items i on i.id = l.trade_id
   where l.token = p_token and i.kind = 'trade' and not i.deleted;
  if not found then return null; end if;
  return jsonb_build_object(
    'trade', jsonb_build_object('id', t.id, 'name', t.data->>'name'),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'data', r.data) order by r.data->>'date' desc, r.updated_at desc)
      from (select * from public.items where kind = 'report' and not deleted and data->>'trade_id' = t.id::text
            order by data->>'date' desc, updated_at desc limit 30) r
    ), '[]'::jsonb));
end $$;

-- 工班送出回報：欄位逐一檢查，長度有上限
create or replace function public.crew_submit(p_token text, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare t public.items; new_id uuid; photos jsonb;
begin
  select i.* into t from public.crew_links l join public.items i on i.id = l.trade_id
   where l.token = p_token and i.kind = 'trade' and not i.deleted;
  if not found then raise exception 'invalid link'; end if;
  if (select count(*) from public.items where kind = 'report' and data->>'trade_id' = t.id::text
       and updated_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many reports';
  end if;
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad date'; end if;
  if length(coalesce(p->>'work', '') || coalesce(p->>'issue', '')) = 0 then raise exception 'empty report'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into photos from (
    select x from jsonb_array_elements_text(case when jsonb_typeof(p->'photos') = 'array' then p->'photos' else '[]'::jsonb end) x
    where x ~ '^crew/[0-9a-f-]{36}\.jpg$' limit 8) s;
  insert into public.items (kind, data, sort) values ('report', jsonb_build_object(
    'date', p->>'date',
    'trade_id', t.id::text,
    'trade', t.data->>'name',
    'by', left(coalesce(p->>'by', ''), 60),
    'people', case when coalesce(p->>'people', '') ~ '^\d{1,3}$' then (p->>'people')::int else null end,
    'work', left(coalesce(p->>'work', ''), 2000),
    'next', left(coalesce(p->>'next', ''), 2000),
    'issue', left(coalesce(p->>'issue', ''), 2000),
    'resolved', false,
    'photos', photos,
    'source', 'crew',
    'created_at', (extract(epoch from now()) * 1000)::bigint
  ), 0) returning id into new_id;
  return new_id;
end $$;

revoke all on function public.crew_open(text) from public;
revoke all on function public.crew_submit(text, jsonb) from public;
revoke all on function public.claim_owner() from public;
grant execute on function public.crew_open(text) to anon, authenticated;
grant execute on function public.crew_submit(text, jsonb) to anon, authenticated;
grant execute on function public.claim_owner() to authenticated;
grant execute on function public.my_email(), public.is_member(), public.is_owner() to anon, authenticated;

-- 照片：公開讀取（檔名是亂數，不知道網址的人看不到），每張上限 3 MB
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists photos_member_insert on storage.objects;
create policy photos_member_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member());
drop policy if exists photos_member_delete on storage.objects;
create policy photos_member_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_member());
drop policy if exists photos_crew_insert on storage.objects;
create policy photos_crew_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos' and name ~ '^crew/[0-9a-f-]{36}\.jpg$');

-- 即時同步：別人改了資料，其他裝置馬上更新
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; when undefined_object then null;
end $$;
