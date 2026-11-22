-- 揪時間 v3：必到者標記、主理人移除成員
-- 在 Supabase → SQL Editor 執行一次即可（可重複執行）。

alter table public.participants add column if not exists required boolean not null default false;

-- save_availability 多一個選填參數 p_required：null = 不改，true/false = 設定自己是不是必到者
drop function if exists public.save_availability(text, text, text);
drop function if exists public.save_availability(text, text, text, boolean);
create or replace function public.save_availability(
  p_event text, p_name text, p_avail text, p_required boolean default null
) returns text
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
    insert into public.participants (event_id, pid, name, avail, required)
    values (p_event, v_pid, n, coalesce(p_avail, ''), coalesce(p_required, false));
  else
    update public.participants
       set avail = coalesce(p_avail, ''), required = coalesce(p_required, required), updated_at = now()
     where event_id = p_event and pid = v_pid;
  end if;
  return v_pid;
exception when unique_violation then
  update public.participants
     set avail = coalesce(p_avail, ''), required = coalesce(p_required, required), updated_at = now()
   where event_id = p_event and lower(name) = lower(n)
  returning pid into v_pid;
  return v_pid;
end $$;

-- 主理人設定某位成員是不是必到者
create or replace function public.set_required(p_event text, p_pin text, p_pid text, p_required boolean) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare st text := public._check_pin(p_event, p_pin);
begin
  if st <> 'ok' then return st; end if;
  update public.participants set required = coalesce(p_required, false), updated_at = now()
   where event_id = p_event and pid = p_pid;
  return 'ok';
end $$;

-- 主理人移除成員（連同他的填寫）
create or replace function public.delete_participant(p_event text, p_pin text, p_pid text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare st text := public._check_pin(p_event, p_pin);
begin
  if st <> 'ok' then return st; end if;
  delete from public.participants where event_id = p_event and pid = p_pid;
  return 'ok';
end $$;

revoke execute on function public.save_availability(text, text, text, boolean) from public;
revoke execute on function public.set_required(text, text, text, boolean) from public;
revoke execute on function public.delete_participant(text, text, text) from public;
grant execute on function public.save_availability(text, text, text, boolean) to anon, authenticated;
grant execute on function public.set_required(text, text, text, boolean) to anon, authenticated;
grant execute on function public.delete_participant(text, text, text) to anon, authenticated;
