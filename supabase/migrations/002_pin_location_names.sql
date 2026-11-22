-- 揪時間 v2：主理人 4 位數密碼、地點、用暱稱回到自己的填寫、90 天自動刪除
-- 在 Supabase → SQL Editor 執行一次即可（可重複執行）。

-- ---------- 地點欄位（公開可讀） ----------
alter table public.events add column if not exists location_name    text check (char_length(location_name) <= 80);
alter table public.events add column if not exists location_address text check (char_length(location_address) <= 200);

-- ---------- 主理人密碼（存在不可讀的 event_secrets 表） ----------
alter table public.event_secrets alter column admin_hash drop not null;
alter table public.event_secrets add column if not exists pin_hash     text;
alter table public.event_secrets add column if not exists fail_count   int not null default 0;
alter table public.event_secrets add column if not exists locked_until timestamptz;

-- 舊版函式改由新版取代
drop function if exists public.create_event(text, text, text, jsonb, int, int, int, int, text);
drop function if exists public.save_availability(text, text, text, text, text);
drop function if exists public.finalize_event(text, text, int, int);

-- 驗證主理人密碼；連續錯 5 次鎖 10 分鐘，避免 4 位數被暴力猜出。
-- 注意：錯誤時「回傳狀態」而不是 raise，否則失敗次數的更新會被一起還原。
drop function if exists public._check_pin(text, text);
create or replace function public._check_pin(p_event text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s public.event_secrets%rowtype;
begin
  select * into s from public.event_secrets where event_id = p_event for update;
  if not found or s.pin_hash is null then return 'no_pin'; end if;
  if s.locked_until is not null and s.locked_until > now() then return 'locked'; end if;
  if coalesce(p_pin, '') ~ '^\d{4}$' and crypt(p_pin, s.pin_hash) = s.pin_hash then
    update public.event_secrets set fail_count = 0, locked_until = null where event_id = p_event;
    return 'ok';
  end if;
  if s.fail_count + 1 >= 5 then
    update public.event_secrets set fail_count = 0, locked_until = now() + interval '10 minutes' where event_id = p_event;
    return 'locked';
  end if;
  update public.event_secrets set fail_count = s.fail_count + 1 where event_id = p_event;
  return 'wrong_pin';
end $$;
revoke execute on function public._check_pin(text, text) from public, anon, authenticated;

create or replace function public.create_event(
  p_id text, p_title text, p_tz text, p_dates jsonb,
  p_start int, p_end int, p_step int, p_duration int,
  p_pin text, p_location_name text default null, p_location_address text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) not between 1 and 14 then raise exception 'bad_dates'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_dates) d where d !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'bad_dates'; end if;
  if coalesce(p_pin, '') !~ '^\d{4}$' then raise exception 'bad_pin'; end if;
  if p_step not in (15, 30, 60) or (p_end - p_start) % p_step <> 0 then raise exception 'bad_range'; end if;

  insert into public.events (id, title, tz, dates, start_min, end_min, step, duration, location_name, location_address)
  values (p_id, trim(p_title), p_tz, p_dates, p_start, p_end, p_step, p_duration,
          nullif(trim(coalesce(p_location_name, '')), ''), nullif(trim(coalesce(p_location_address, '')), ''));
  insert into public.event_secrets (event_id, pin_hash) values (p_id, crypt(p_pin, gen_salt('bf')));
end $$;

drop function if exists public.verify_admin(text, text);
create or replace function public.verify_admin(p_event text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  return public._check_pin(p_event, p_pin);
end $$;

drop function if exists public.update_event(text, text, text, text, text);
create or replace function public.update_event(
  p_event text, p_pin text, p_title text, p_location_name text, p_location_address text
) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare st text := public._check_pin(p_event, p_pin);
begin
  if st <> 'ok' then return st; end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 60 then raise exception 'bad_title'; end if;
  update public.events
     set title = trim(p_title),
         location_name = nullif(trim(coalesce(p_location_name, '')), ''),
         location_address = nullif(trim(coalesce(p_location_address, '')), '')
   where id = p_event;
  return 'ok';
end $$;

create or replace function public.finalize_event(p_event text, p_pin text, p_start int, p_slots int) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare st text := public._check_pin(p_event, p_pin);
begin
  if st <> 'ok' then return st; end if;
  update public.events set final_start = p_start, final_slots = p_slots where id = p_event;
  return 'ok';
end $$;

drop function if exists public.delete_event(text, text);
create or replace function public.delete_event(p_event text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare st text := public._check_pin(p_event, p_pin);
begin
  if st <> 'ok' then return st; end if;
  delete from public.events where id = p_event;
  return 'ok';
end $$;

-- 用暱稱當身份：同一個活動裡，輸入相同暱稱（不分大小寫）就是同一個人
create or replace function public.save_availability(p_event text, p_name text, p_avail text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  n text := trim(coalesce(p_name, ''));
  v_pid text;
begin
  if char_length(n) not between 1 and 20 then raise exception 'bad_name'; end if;
  if char_length(coalesce(p_avail, '')) > 4000 then raise exception 'bad_avail'; end if;
  select pid into v_pid from public.participants where event_id = p_event and lower(name) = lower(n);
  if v_pid is null then
    if not exists (select 1 from public.events where id = p_event) then raise exception 'no_event'; end if;
    if (select count(*) from public.participants where event_id = p_event) >= 200 then raise exception 'too_many'; end if;
    v_pid := substr(md5(random()::text || clock_timestamp()::text), 1, 12);
    insert into public.participants (event_id, pid, name, avail) values (p_event, v_pid, n, coalesce(p_avail, ''));
  else
    update public.participants set avail = coalesce(p_avail, ''), updated_at = now()
     where event_id = p_event and pid = v_pid;
  end if;
  return v_pid;
exception when unique_violation then
  -- 兩個人同時用同一個新暱稱：改成更新既有那筆
  update public.participants set avail = coalesce(p_avail, ''), updated_at = now()
   where event_id = p_event and lower(name) = lower(n)
  returning pid into v_pid;
  return v_pid;
end $$;

revoke execute on function public.create_event(text, text, text, jsonb, int, int, int, int, text, text, text) from public;
revoke execute on function public.verify_admin(text, text) from public;
revoke execute on function public.update_event(text, text, text, text, text) from public;
revoke execute on function public.finalize_event(text, text, int, int) from public;
revoke execute on function public.delete_event(text, text) from public;
revoke execute on function public.save_availability(text, text, text) from public;
grant execute on function public.create_event(text, text, text, jsonb, int, int, int, int, text, text, text) to anon, authenticated;
grant execute on function public.verify_admin(text, text) to anon, authenticated;
grant execute on function public.update_event(text, text, text, text, text) to anon, authenticated;
grant execute on function public.finalize_event(text, text, int, int) to anon, authenticated;
grant execute on function public.delete_event(text, text) to anon, authenticated;
grant execute on function public.save_availability(text, text, text) to anon, authenticated;

-- 舊的個人編輯金鑰不再使用
drop table if exists public.participant_secrets;

-- 清掉部署時建立的測試活動
delete from public.events where id = 'testlncte0';

-- ---------- 90 天自動刪除 ----------
create extension if not exists pg_cron with schema pg_catalog;
select cron.unschedule(jobid) from cron.job where jobname = 'jiu-purge-expired';
select cron.schedule('jiu-purge-expired', '17 19 * * *', $$delete from public.events where expires_at < now()$$);
