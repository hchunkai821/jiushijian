-- 揪時間 資料庫結構
-- 在 Supabase 後台 → SQL Editor 貼上整份檔案，按 Run 執行一次即可。
--
-- 設計重點：
-- 1. 免註冊：不使用帳號登入。每位參與者有一組隨機的「編輯金鑰」(token)，只存在他的瀏覽器裡。
-- 2. 所有寫入都經過下面的函式 (RPC)，函式會比對金鑰的雜湊值，所以別人無法改你的資料。
-- 3. 金鑰雜湊存在 *_secrets 表，這兩張表對前端完全不可讀。

create extension if not exists pgcrypto with schema extensions;

-- ---------- 資料表 ----------
create table if not exists public.events (
  id          text primary key check (id ~ '^[a-z0-9]{6,16}$'),
  title       text not null check (char_length(title) between 1 and 60),
  tz          text not null check (char_length(tz) between 1 and 64),
  dates       jsonb not null,
  start_min   int  not null check (start_min between 0 and 1439),
  end_min     int  not null check (end_min between 1 and 1440 and end_min > start_min),
  step        int  not null check (step in (15, 30, 60)),
  duration    int  not null check (duration between 15 and 1440),
  final_start int,
  final_slots int,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '90 days'
);

create table if not exists public.event_secrets (
  event_id   text primary key references public.events(id) on delete cascade,
  admin_hash text not null
);

create table if not exists public.participants (
  event_id   text not null references public.events(id) on delete cascade,
  pid        text not null check (pid ~ '^[A-Za-z0-9]{6,32}$'),
  name       text not null check (char_length(name) between 1 and 20),
  avail      text not null default '' check (char_length(avail) <= 4000),
  updated_at timestamptz not null default now(),
  primary key (event_id, pid)
);
create unique index if not exists participants_name_uniq on public.participants (event_id, lower(name));

create table if not exists public.participant_secrets (
  event_id   text not null,
  pid        text not null,
  token_hash text not null,
  primary key (event_id, pid),
  foreign key (event_id, pid) references public.participants(event_id, pid) on delete cascade
);

-- ---------- 權限 (Row Level Security) ----------
alter table public.events              enable row level security;
alter table public.event_secrets       enable row level security;
alter table public.participants        enable row level security;
alter table public.participant_secrets enable row level security;

drop policy if exists "anyone can read events" on public.events;
create policy "anyone can read events" on public.events for select to anon, authenticated using (true);

drop policy if exists "anyone can read participants" on public.participants;
create policy "anyone can read participants" on public.participants for select to anon, authenticated using (true);

-- secrets 表沒有任何 policy，再把權限整個收回：前端讀不到、寫不到
revoke all on public.event_secrets, public.participant_secrets from anon, authenticated;
-- 前端也不能直接 insert/update/delete，只能透過下面的函式
revoke insert, update, delete on public.events, public.participants from anon, authenticated;

-- ---------- 函式 ----------
create or replace function public.create_event(
  p_id text, p_title text, p_tz text, p_dates jsonb,
  p_start int, p_end int, p_step int, p_duration int, p_admin_token text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) not between 1 and 14 then
    raise exception 'bad_dates';
  end if;
  if exists (select 1 from jsonb_array_elements_text(p_dates) d where d !~ '^\d{4}-\d{2}-\d{2}$') then
    raise exception 'bad_dates';
  end if;
  if char_length(coalesce(p_admin_token, '')) < 16 then raise exception 'bad_token'; end if;
  if p_step not in (15, 30, 60) or (p_end - p_start) % p_step <> 0 then raise exception 'bad_range'; end if;

  insert into public.events (id, title, tz, dates, start_min, end_min, step, duration)
  values (p_id, trim(p_title), p_tz, p_dates, p_start, p_end, p_step, p_duration);
  insert into public.event_secrets values (p_id, encode(digest(p_admin_token, 'sha256'), 'hex'));
end $$;

create or replace function public.save_availability(
  p_event text, p_pid text, p_token text, p_name text, p_avail text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  h text;
  existing text;
begin
  if char_length(coalesce(p_token, '')) < 16 then raise exception 'bad_token'; end if;
  h := encode(digest(p_token, 'sha256'), 'hex');
  select token_hash into existing from public.participant_secrets where event_id = p_event and pid = p_pid;

  if existing is null then
    if not exists (select 1 from public.events where id = p_event) then raise exception 'no_event'; end if;
    if (select count(*) from public.participants where event_id = p_event) >= 200 then raise exception 'too_many'; end if;
    insert into public.participants (event_id, pid, name, avail) values (p_event, p_pid, trim(p_name), p_avail);
    insert into public.participant_secrets values (p_event, p_pid, h);
  elsif existing = h then
    update public.participants set name = trim(p_name), avail = p_avail, updated_at = now()
    where event_id = p_event and pid = p_pid;
  else
    raise exception 'forbidden';
  end if;
exception when unique_violation then
  raise exception 'name_taken';
end $$;

create or replace function public.finalize_event(
  p_event text, p_admin_token text, p_start int, p_slots int
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (
    select 1 from public.event_secrets
    where event_id = p_event and admin_hash = encode(digest(coalesce(p_admin_token, ''), 'sha256'), 'hex')
  ) then
    raise exception 'forbidden';
  end if;
  update public.events set final_start = p_start, final_slots = p_slots where id = p_event;
end $$;

grant execute on function public.create_event(text, text, text, jsonb, int, int, int, int, text) to anon, authenticated;
grant execute on function public.save_availability(text, text, text, text, text) to anon, authenticated;
grant execute on function public.finalize_event(text, text, int, int) to anon, authenticated;

-- ---------- 即時同步 ----------
do $$ begin
  alter publication supabase_realtime add table public.participants;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null; end $$;

-- ---------- （選用）自動刪除過期活動 ----------
-- 到 Database → Extensions 開啟 pg_cron 後，再執行下面這行：
-- select cron.schedule('jiu-purge-expired', '17 3 * * *', $$delete from public.events where expires_at < now()$$);
