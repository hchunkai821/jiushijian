-- 揪時間 v4：日期範圍從最多 14 天放寬到最多 31 天（例如 11/11 到 12/10）
-- 在 Supabase → SQL Editor 執行一次即可（可重複執行）。

create or replace function public.create_event(
  p_id text, p_title text, p_tz text, p_dates jsonb,
  p_start int, p_end int, p_step int, p_duration int,
  p_pin text, p_location_name text default null, p_location_address text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) not between 1 and 31 then raise exception 'bad_dates'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_dates) d where d !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'bad_dates'; end if;
  if coalesce(p_pin, '') !~ '^\d{4}$' then raise exception 'bad_pin'; end if;
  if p_step not in (15, 30, 60) or (p_end - p_start) % p_step <> 0 then raise exception 'bad_range'; end if;

  insert into public.events (id, title, tz, dates, start_min, end_min, step, duration, location_name, location_address)
  values (p_id, trim(p_title), p_tz, p_dates, p_start, p_end, p_step, p_duration,
          nullif(trim(coalesce(p_location_name, '')), ''), nullif(trim(coalesce(p_location_address, '')), ''));
  insert into public.event_secrets (event_id, pin_hash) values (p_id, crypt(p_pin, gen_salt('bf')));
end $$;
revoke execute on function public.create_event(text, text, text, jsonb, int, int, int, int, text, text, text) from public;
grant execute on function public.create_event(text, text, text, jsonb, int, int, int, int, text, text, text) to anon, authenticated;
