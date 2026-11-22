-- 揪時間 v5：資安與個資強化（搬到 GitHub Pages 前必須執行）
-- 在 Supabase → SQL Editor 貼上整份檔案執行一次即可（可重複執行）。
--
-- 這一版修正的問題與做法：
-- 1. 資料外洩：以前 events / participants 開放 anon 直接 select，任何人拿公開金鑰就能列出「所有」活動、
--    地址、暱稱與時間。現在收回所有資料表權限，只能透過 get_event(活動代碼) 讀「一個」活動，
--    活動代碼由伺服器產生 12 碼隨機字元（31^12 ≈ 7.9×10^17 種），猜不到也列不出來。
-- 2. 冒名修改：以前知道暱稱就能改別人的時間。現在每位參與者有 4 位數個人密碼，
--    登入後伺服器發給瀏覽器一組隨機 session token（資料庫只存雜湊），之後寫入都要帶 token。
-- 3. 暴力猜密碼：主理人與參與者密碼都是 bcrypt 雜湊；連錯 5 次鎖定，鎖定時間每次加倍（10 分、20 分、40 分…），
--    並且每個 IP 有嘗試次數上限。主理人登入後用 session token 操作，被別人惡意鎖定也不影響已登入的裝置。
-- 4. 濫用 / 灌資料：建立活動、讀取、寫入都有每個 IP 與全站的頻率限制。IP 只以「加鹽雜湊」暫存，一天後刪除。
-- 5. 即時同步不再透過 postgres_changes（那需要開放資料表讀取權限），改由資料庫觸發器送出
--    「這個活動有變動」的廣播（不含任何資料），前端收到後再用 get_event 重新讀取。
-- 6. 機密資料搬到 private schema，PostgREST 完全不對外公開這個 schema。

create extension if not exists pgcrypto with schema extensions;

-- ============ private schema：機密資料與內部函式 ============
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$ begin
  if to_regclass('public.event_secrets') is not null and to_regclass('private.event_secrets') is null then
    alter table public.event_secrets set schema private;
  end if;
end $$;
alter table private.event_secrets add column if not exists lock_level int not null default 0;

create table if not exists private.member_secrets (
  event_id     text not null,
  pid          text not null,
  pin_hash     text not null,
  fail_count   int not null default 0,
  lock_level   int not null default 0,
  locked_until timestamptz,
  primary key (event_id, pid),
  foreign key (event_id, pid) references public.participants(event_id, pid) on delete cascade
);

create table if not exists private.sessions (
  token_hash text primary key,
  event_id   text not null references public.events(id) on delete cascade,
  role       text not null check (role in ('admin', 'member')),
  pid        text,
  created_at timestamptz not null default now(),
  check ((role = 'admin') = (pid is null)),
  foreign key (event_id, pid) references public.participants(event_id, pid) on delete cascade
);
create index if not exists sessions_event_idx on private.sessions (event_id);

create table if not exists private.rate_limits (
  k   text not null,
  win timestamptz not null,
  n   int not null default 0,
  primary key (k, win)
);

create table if not exists private.app_salt (
  id   int primary key default 1 check (id = 1),
  salt text not null
);
insert into private.app_salt (salt) values (encode(extensions.gen_random_bytes(32), 'hex')) on conflict (id) do nothing;

alter table private.event_secrets  enable row level security;
alter table private.member_secrets enable row level security;
alter table private.sessions       enable row level security;
alter table private.rate_limits    enable row level security;
alter table private.app_salt       enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;

-- ---------- 頻率限制：每個 IP（加鹽雜湊）與全站 ----------
create or replace function private.rate_ok(p_bucket text, p_max int, p_window int, p_global boolean default false)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  hdr json;
  ip  text;
  key text;
  w   timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window) * p_window);
  cnt int;
begin
  if p_global then
    key := 'global|' || p_bucket;
  else
    begin
      hdr := nullif(current_setting('request.headers', true), '')::json;
    exception when others then
      hdr := null;
    end;
    -- cf-connecting-ip 由 Cloudflare 設定，用戶端無法偽造；其次才用其他標頭
    ip := coalesce(nullif(trim(hdr ->> 'cf-connecting-ip'), ''),
                   nullif(trim(hdr ->> 'x-real-ip'), ''),
                   nullif(trim(reverse(split_part(reverse(coalesce(hdr ->> 'x-forwarded-for', '')), ',', 1))), ''),
                   'unknown');
    key := encode(extensions.digest(ip || '|' || p_bucket || '|' || (select s.salt from private.app_salt s where s.id = 1), 'sha256'), 'hex');
  end if;
  insert into private.rate_limits as r (k, win, n) values (key, w, 1)
  on conflict (k, win) do update set n = r.n + 1
  returning r.n into cnt;
  return cnt <= p_max;
end $$;

create or replace function private.check_rate(p_bucket text, p_ip_max int, p_global_max int, p_window int)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.rate_ok(p_bucket, p_ip_max, p_window) or not private.rate_ok(p_bucket, p_global_max, p_window, true) then
    raise exception 'rate_limited';
  end if;
end $$;

-- ---------- token 與代碼 ----------
create or replace function private.new_token() returns text
language sql volatile set search_path = '' as $$
  select encode(extensions.gen_random_bytes(32), 'hex')
$$;

create or replace function private.hash_token(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create or replace function private.new_event_id() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', (get_byte(b, i) % 31) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(12) as b) x, generate_series(0, 11) as i
$$;

create or replace function private.issue_session(p_event text, p_role text, p_pid text) returns text
language plpgsql security definer set search_path = '' as $$
declare t text := private.new_token();
begin
  insert into private.sessions (token_hash, event_id, role, pid) values (private.hash_token(t), p_event, p_role, p_pid);
  -- 每個身份最多保留 10 個登入中的裝置，舊的自動登出
  delete from private.sessions s
   where s.event_id = p_event and s.role = p_role and s.pid is not distinct from p_pid
     and s.token_hash not in (
       select s2.token_hash from private.sessions s2
        where s2.event_id = p_event and s2.role = p_role and s2.pid is not distinct from p_pid
        order by s2.created_at desc limit 10);
  return t;
end $$;

-- 回傳 true 表示這組 token 是這個活動、這個角色的有效登入
create or replace function private.session_ok(p_event text, p_token text, p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.sessions s
     where s.token_hash = private.hash_token(p_token) and s.event_id = p_event and s.role = p_role
  ) and char_length(coalesce(p_token, '')) = 64
$$;

create or replace function private.session_pid(p_event text, p_token text) returns text
language sql stable security definer set search_path = '' as $$
  select s.pid from private.sessions s
   where char_length(coalesce(p_token, '')) = 64
     and s.token_hash = private.hash_token(p_token) and s.event_id = p_event and s.role = 'member'
$$;

-- 鎖定時間：10 分鐘 × 2^level，最長 30 天（活動本身 90 天後刪除）
create or replace function private.lock_interval(p_level int) returns interval
language sql immutable set search_path = '' as $$
  select least(interval '10 minutes' * power(2, least(p_level, 20)), interval '30 days')
$$;

-- 即時同步：只廣播「活動 X 有變動」，不帶任何資料
create or replace function private.notify_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare eid text;
begin
  if tg_table_name = 'events' then
    eid := coalesce(new.id, old.id);
  else
    eid := coalesce(new.event_id, old.event_id);
  end if;
  begin
    perform realtime.send(jsonb_build_object('at', extract(epoch from now())), 'changed', 'ev-' || eid, false);
  exception when others then
    null; -- 廣播失敗不影響寫入；前端另有定時重新整理
  end;
  return null;
end $$;

drop trigger if exists jsj_notify on public.events;
create trigger jsj_notify after update or delete on public.events
  for each row execute function private.notify_change();
drop trigger if exists jsj_notify on public.participants;
create trigger jsj_notify after insert or update or delete on public.participants
  for each row execute function private.notify_change();

revoke execute on all functions in schema private from public, anon, authenticated;

-- ============ 收回所有直接存取資料表的權限 ============
drop policy if exists "anyone can read events" on public.events;
drop policy if exists "anyone can read participants" on public.participants;
alter table public.events       enable row level security;
alter table public.participants enable row level security;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- 之後新建的資料表也不會自動開放給前端
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

do $$ begin
  alter publication supabase_realtime drop table public.participants;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime drop table public.events;
exception when others then null; end $$;

-- ============ 舊版函式全部移除 ============
drop function if exists public._check_pin(text, text);
drop function if exists public.verify_admin(text, text);
drop function if exists public.create_event(text, text, text, jsonb, int, int, int, int, text, text, text);
drop function if exists public.update_event(text, text, text, text, text);
drop function if exists public.finalize_event(text, text, int, int);
drop function if exists public.delete_event(text, text);
drop function if exists public.save_availability(text, text, text);
drop function if exists public.save_availability(text, text, text, boolean);
drop function if exists public.set_required(text, text, text, boolean);
drop function if exists public.delete_participant(text, text, text);

-- ============ 對外公開的函式 ============

-- 讀取單一活動（含成員）；找不到或過期回傳 null
create or replace function public.get_event(p_event text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if coalesce(p_event, '') !~ '^[a-z0-9]{6,16}$' then return null; end if;
  perform private.check_rate('read', 300, 20000, 60);
  select jsonb_build_object(
           'event', jsonb_build_object(
             'id', e.id, 'title', e.title, 'tz', e.tz, 'dates', e.dates,
             'start_min', e.start_min, 'end_min', e.end_min, 'step', e.step, 'duration', e.duration,
             'final_start', e.final_start, 'final_slots', e.final_slots,
             'location_name', e.location_name, 'location_address', e.location_address),
           'people', coalesce((
             select jsonb_agg(jsonb_build_object('pid', p.pid, 'name', p.name, 'avail', p.avail, 'required', p.required) order by p.updated_at)
               from public.participants p where p.event_id = e.id), '[]'::jsonb))
    into r
    from public.events e
   where e.id = p_event and e.expires_at > now();
  return r;
end $$;

-- 建立活動：代碼由伺服器產生，回傳 { id, token }（token 是主理人登入憑證）
create or replace function public.create_event(
  p_title text, p_tz text, p_dates jsonb,
  p_start int, p_end int, p_step int, p_duration int,
  p_pin text, p_location_name text default null, p_location_address text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id text;
  v_title text := trim(coalesce(p_title, ''));
begin
  perform private.check_rate('create', 10, 500, 3600);
  if char_length(v_title) not between 1 and 60 then raise exception 'bad_title'; end if;
  if char_length(coalesce(p_tz, '')) not between 1 and 64 or p_tz !~ '^[A-Za-z0-9_+\-/]+$' then raise exception 'bad_tz'; end if;
  if jsonb_typeof(p_dates) is distinct from 'array' or jsonb_array_length(p_dates) not between 1 and 31 then raise exception 'bad_dates'; end if;
  if exists (select 1 from jsonb_array_elements(p_dates) d where jsonb_typeof(d) <> 'string' or d #>> '{}' !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'bad_dates'; end if;
  if coalesce(p_pin, '') !~ '^\d{4}$' then raise exception 'bad_pin'; end if;
  if p_step not in (15, 30, 60) or p_start is null or p_end is null or p_start < 0 or p_end > 1440 or p_end <= p_start
     or (p_end - p_start) % p_step <> 0 then raise exception 'bad_range'; end if;
  if p_duration is null or p_duration < p_step or p_duration > p_end - p_start then raise exception 'bad_duration'; end if;
  if char_length(coalesce(p_location_name, '')) > 80 or char_length(coalesce(p_location_address, '')) > 200 then raise exception 'bad_location'; end if;

  for i in 1..5 loop
    v_id := private.new_event_id();
    exit when not exists (select 1 from public.events e where e.id = v_id);
  end loop;

  insert into public.events (id, title, tz, dates, start_min, end_min, step, duration, location_name, location_address)
  values (v_id, v_title, p_tz, p_dates, p_start, p_end, p_step, p_duration,
          nullif(trim(coalesce(p_location_name, '')), ''), nullif(trim(coalesce(p_location_address, '')), ''));
  insert into private.event_secrets (event_id, pin_hash) values (v_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
  return jsonb_build_object('id', v_id, 'token', private.issue_session(v_id, 'admin', null));
end $$;

-- 主理人用 4 位數密碼登入，成功回傳 { status: 'ok', token }
create or replace function public.admin_login(p_event text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s private.event_secrets%rowtype;
begin
  if not private.rate_ok('pin', 30, 600) then return jsonb_build_object('status', 'rate_limited'); end if;
  select * into s from private.event_secrets where event_id = p_event for update;
  if not found or s.pin_hash is null then return jsonb_build_object('status', 'no_pin'); end if;
  if s.locked_until is not null and s.locked_until > now() then
    return jsonb_build_object('status', 'locked', 'until', s.locked_until);
  end if;
  if coalesce(p_pin, '') ~ '^\d{4}$' and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash then
    update private.event_secrets set fail_count = 0, lock_level = 0, locked_until = null where event_id = p_event;
    return jsonb_build_object('status', 'ok', 'token', private.issue_session(p_event, 'admin', null));
  end if;
  if s.fail_count + 1 >= 5 then
    update private.event_secrets
       set fail_count = 0, lock_level = s.lock_level + 1, locked_until = now() + private.lock_interval(s.lock_level)
     where event_id = p_event;
    return jsonb_build_object('status', 'locked', 'until', now() + private.lock_interval(s.lock_level));
  end if;
  update private.event_secrets set fail_count = s.fail_count + 1 where event_id = p_event;
  return jsonb_build_object('status', 'wrong_pin');
end $$;

-- 參與者用「暱稱 + 4 位數個人密碼」加入或回到自己的填寫
-- status：created（新成員）、claimed（舊成員第一次設定密碼）、ok、wrong_pin、locked、too_many、no_event、rate_limited
create or replace function public.join_event(p_event text, p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n text := trim(coalesce(p_name, ''));
  v_pid text;
  ms private.member_secrets%rowtype;
begin
  if char_length(n) not between 1 and 20 then raise exception 'bad_name'; end if;
  if coalesce(p_pin, '') !~ '^\d{4}$' then raise exception 'bad_pin'; end if;
  if not private.rate_ok('pin', 30, 600) then return jsonb_build_object('status', 'rate_limited'); end if;
  if not exists (select 1 from public.events e where e.id = p_event and e.expires_at > now()) then
    return jsonb_build_object('status', 'no_event');
  end if;

  select p.pid into v_pid from public.participants p where p.event_id = p_event and lower(p.name) = lower(n) for update;

  if v_pid is null then
    if not private.rate_ok('member', 30, 3600) then return jsonb_build_object('status', 'rate_limited'); end if;
    if (select count(*) from public.participants p where p.event_id = p_event) >= 200 then
      return jsonb_build_object('status', 'too_many');
    end if;
    v_pid := encode(extensions.gen_random_bytes(8), 'hex');
    begin
      insert into public.participants (event_id, pid, name, avail) values (p_event, v_pid, n, '');
    exception when unique_violation then
      return jsonb_build_object('status', 'retry');
    end;
    insert into private.member_secrets (event_id, pid, pin_hash) values (p_event, v_pid, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
    return jsonb_build_object('status', 'created', 'pid', v_pid, 'token', private.issue_session(p_event, 'member', v_pid));
  end if;

  select * into ms from private.member_secrets m where m.event_id = p_event and m.pid = v_pid for update;
  if not found then
    -- 舊版（v4 以前）沒有密碼的成員：第一個設定密碼的人取得這個暱稱
    insert into private.member_secrets (event_id, pid, pin_hash) values (p_event, v_pid, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
    return jsonb_build_object('status', 'claimed', 'pid', v_pid, 'token', private.issue_session(p_event, 'member', v_pid));
  end if;
  if ms.locked_until is not null and ms.locked_until > now() then
    return jsonb_build_object('status', 'locked', 'until', ms.locked_until);
  end if;
  if extensions.crypt(p_pin, ms.pin_hash) = ms.pin_hash then
    update private.member_secrets set fail_count = 0, lock_level = 0, locked_until = null where event_id = p_event and pid = v_pid;
    return jsonb_build_object('status', 'ok', 'pid', v_pid, 'token', private.issue_session(p_event, 'member', v_pid));
  end if;
  if ms.fail_count + 1 >= 5 then
    update private.member_secrets
       set fail_count = 0, lock_level = ms.lock_level + 1, locked_until = now() + private.lock_interval(ms.lock_level)
     where event_id = p_event and pid = v_pid;
    return jsonb_build_object('status', 'locked', 'until', now() + private.lock_interval(ms.lock_level));
  end if;
  update private.member_secrets set fail_count = ms.fail_count + 1 where event_id = p_event and pid = v_pid;
  return jsonb_build_object('status', 'wrong_pin');
end $$;

-- 儲存自己的時間（需要參與者 token）；p_required：null = 不改
create or replace function public.save_availability(p_event text, p_token text, p_avail text, p_required boolean default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare v_pid text;
begin
  perform private.check_rate('write', 120, 20000, 60);
  v_pid := private.session_pid(p_event, p_token);
  if v_pid is null then return 'forbidden'; end if;
  if char_length(coalesce(p_avail, '')) > 4000 or coalesce(p_avail, '') !~ '^[A-Za-z0-9+/]*={0,2}$' then raise exception 'bad_avail'; end if;
  update public.participants
     set avail = coalesce(p_avail, ''), required = coalesce(p_required, required), updated_at = now()
   where event_id = p_event and pid = v_pid;
  return 'ok';
end $$;

-- 登出（刪除這組 token）
create or replace function public.end_session(p_event text, p_token text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.sessions where token_hash = private.hash_token(p_token) and event_id = p_event;
  return 'ok';
end $$;

-- 檢查主理人 token 是否仍有效（例如換了密碼或被登出）
create or replace function public.admin_check(p_event text, p_token text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_rate('read', 300, 20000, 60);
  return case when private.session_ok(p_event, p_token, 'admin') then 'ok' else 'forbidden' end;
end $$;

create or replace function public.update_event(
  p_event text, p_token text, p_title text, p_location_name text, p_location_address text
) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_rate('write', 120, 20000, 60);
  if not private.session_ok(p_event, p_token, 'admin') then return 'forbidden'; end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 60 then raise exception 'bad_title'; end if;
  if char_length(coalesce(p_location_name, '')) > 80 or char_length(coalesce(p_location_address, '')) > 200 then raise exception 'bad_location'; end if;
  update public.events
     set title = trim(p_title),
         location_name = nullif(trim(coalesce(p_location_name, '')), ''),
         location_address = nullif(trim(coalesce(p_location_address, '')), '')
   where id = p_event;
  return 'ok';
end $$;

create or replace function public.finalize_event(p_event text, p_token text, p_start int, p_slots int) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_rate('write', 120, 20000, 60);
  if not private.session_ok(p_event, p_token, 'admin') then return 'forbidden'; end if;
  if (p_start is null) <> (p_slots is null) or p_start < 0 or p_slots < 1 or p_slots > 1440 then raise exception 'bad_range'; end if;
  update public.events set final_start = p_start, final_slots = p_slots where id = p_event;
  return 'ok';
end $$;

create or replace function public.delete_event(p_event text, p_token text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_rate('write', 120, 20000, 60);
  if not private.session_ok(p_event, p_token, 'admin') then return 'forbidden'; end if;
  delete from public.events where id = p_event;
  return 'ok';
end $$;

create or replace function public.set_required(p_event text, p_token text, p_pid text, p_required boolean) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_rate('write', 120, 20000, 60);
  if not private.session_ok(p_event, p_token, 'admin') then return 'forbidden'; end if;
  update public.participants set required = coalesce(p_required, false), updated_at = now()
   where event_id = p_event and pid = p_pid;
  return 'ok';
end $$;

-- 主理人移除成員（連同他的填寫、密碼與登入中的裝置）
create or replace function public.delete_participant(p_event text, p_token text, p_pid text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_rate('write', 120, 20000, 60);
  if not private.session_ok(p_event, p_token, 'admin') then return 'forbidden'; end if;
  delete from public.participants where event_id = p_event and pid = p_pid;
  return 'ok';
end $$;

-- 主理人重設某位成員的個人密碼（成員忘記密碼時用）：清除密碼並登出他的所有裝置，
-- 成員下次輸入同一個暱稱時重新設定密碼
create or replace function public.reset_member_pin(p_event text, p_token text, p_pid text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_rate('write', 120, 20000, 60);
  if not private.session_ok(p_event, p_token, 'admin') then return 'forbidden'; end if;
  delete from private.member_secrets where event_id = p_event and pid = p_pid;
  delete from private.sessions where event_id = p_event and pid = p_pid;
  return 'ok';
end $$;

-- ============ 權限：只開放上面這些函式 ============
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_event(text) to anon;
grant execute on function public.create_event(text, text, jsonb, int, int, int, int, text, text, text) to anon;
grant execute on function public.admin_login(text, text) to anon;
grant execute on function public.admin_check(text, text) to anon;
grant execute on function public.join_event(text, text, text) to anon;
grant execute on function public.save_availability(text, text, text, boolean) to anon;
grant execute on function public.end_session(text, text) to anon;
grant execute on function public.update_event(text, text, text, text, text) to anon;
grant execute on function public.finalize_event(text, text, int, int) to anon;
grant execute on function public.delete_event(text, text) to anon;
grant execute on function public.set_required(text, text, text, boolean) to anon;
grant execute on function public.delete_participant(text, text, text) to anon;
grant execute on function public.reset_member_pin(text, text, text) to anon;

-- ============ 排程：過期資料清除 ============
create extension if not exists pg_cron with schema pg_catalog;
select cron.unschedule(jobid) from cron.job where jobname in ('jiu-purge-expired', 'jiu-purge-ratelimits');
-- 每天台灣時間 03:17 刪除建立超過 90 天的活動（成員、密碼、登入狀態一併刪除）
select cron.schedule('jiu-purge-expired', '17 19 * * *', $$delete from public.events where expires_at < now()$$);
-- 每小時刪除超過 1 天的頻率限制紀錄（IP 雜湊）
select cron.schedule('jiu-purge-ratelimits', '7 * * * *', $$delete from private.rate_limits where win < now() - interval '1 day'$$);
