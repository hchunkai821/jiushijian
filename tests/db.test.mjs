// 資料庫資安測試：只用公開的 anon 金鑰，從 REST API 嘗試各種攻擊
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { rest, rpc, sql, freshIp } from './helpers.mjs';

const newEvent = async (overrides = {}, ip = freshIp()) => {
  const r = await rpc('create_event', { p_title: '資安測試', p_tz: 'Asia/Taipei', p_dates: ['2026-12-01', '2026-12-02'], p_start: 540, p_end: 720, p_step: 30, p_duration: 60, p_pin: '4321', ...overrides }, { ip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const join = async (eid, name, pin, ip = freshIp()) => (await rpc('join_event', { p_event: eid, p_name: name, p_pin: pin }, { ip })).body;
const errMsg = r => String(r.body && r.body.message);

let ev;
before(async () => { ev = await newEvent(); });

test('無法直接讀取任何資料表', async () => {
  for (const t of ['events', 'participants']) {
    const r = await rest(`/${t}?select=*`);
    assert.equal(r.status, 401, t);
    assert.equal(r.body.code, '42501', t);
  }
  for (const t of ['event_secrets', 'member_secrets', 'sessions', 'rate_limits', 'app_salt']) {
    const r = await rest(`/${t}?select=*`);
    assert.equal(r.status, 404, `${t} 不應該出現在 API`);
  }
});

test('無法直接寫入資料表', async () => {
  const r = await rest('/events', { method: 'POST', body: { id: 'hackhack01', title: 'x', tz: 'UTC', dates: ['2026-12-01'], start_min: 0, end_min: 60, step: 30, duration: 30 } });
  assert.equal(r.status, 401);
  const d = await rest(`/participants?event_id=eq.${ev.id}`, { method: 'DELETE' });
  assert.equal(d.status, 401);
});

test('內部函式與舊版函式都不能呼叫', async () => {
  for (const fn of ['rate_ok', 'new_token', 'issue_session', '_check_pin', 'verify_admin']) {
    const r = await rpc(fn, {});
    assert.equal(r.status, 404, fn);
  }
});

test('anon 只能執行網站需要的 13 個函式', () => {
  const list = sql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and has_function_privilege('anon', p.oid, 'execute')`);
  assert.equal(list, 'admin_check,admin_login,create_event,delete_event,delete_participant,end_session,finalize_event,get_event,join_event,reset_member_pin,save_availability,set_required,update_event');
  assert.equal(sql(`select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema in ('public','private')`), '0');
});

test('建立活動：代碼由伺服器產生 12 碼，回傳 256 位元 token', () => {
  assert.match(ev.id, /^[a-z0-9]{12}$/);
  assert.match(ev.token, /^[0-9a-f]{64}$/);
});

test('get_event 只回傳單一活動，不含任何密碼或 token', async () => {
  const r = await rpc('get_event', { p_event: ev.id });
  assert.equal(r.body.event.title, '資安測試');
  assert.doesNotMatch(JSON.stringify(r.body), /hash|pin|token|secret|expires|created/i);
  assert.equal((await rpc('get_event', { p_event: 'zzzzzzzz' })).body, null);
  assert.equal((await rpc('get_event', { p_event: "x' or 1=1 --" })).body, null);
});

test('參與者：暱稱 + 密碼，冒名會被擋', async () => {
  const a = await join(ev.id, '小明', '1111');
  assert.equal(a.status, 'created');
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.equal((await join(ev.id, '小明', '2222')).status, 'wrong_pin');
  assert.equal((await join(ev.id, ' 小明 ', '1111')).status, 'ok', '前後空白要忽略');
  const save = await rpc('save_availability', { p_event: ev.id, p_token: a.token, p_avail: 'Aw==', p_required: true });
  assert.equal(save.body, 'ok');
  const people = (await rpc('get_event', { p_event: ev.id })).body.people;
  assert.equal(people[0].avail, 'Aw==');
  assert.equal(people[0].required, true);
});

test('寫入一定要有效的參與者 token', async () => {
  const other = await newEvent();
  const m = await join(ev.id, '小華', '3333');
  assert.equal((await rpc('save_availability', { p_event: ev.id, p_token: 'a'.repeat(64), p_avail: 'Aw==' })).body, 'forbidden');
  assert.equal((await rpc('save_availability', { p_event: ev.id, p_token: ev.token, p_avail: 'Aw==' })).body, 'forbidden', '主理人 token 不能當成員 token');
  assert.equal((await rpc('save_availability', { p_event: other.id, p_token: m.token, p_avail: 'Aw==' })).body, 'forbidden', '不能拿到別的活動用');
  const bad = await rpc('save_availability', { p_event: ev.id, p_token: m.token, p_avail: '<script>' });
  assert.match(errMsg(bad), /bad_avail/);
});

test('管理功能只接受主理人 token', async () => {
  const m = await join(ev.id, '阿哲', '4444');
  assert.equal((await rpc('update_event', { p_event: ev.id, p_token: m.token, p_title: '被改了', p_location_name: null, p_location_address: null })).body, 'forbidden');
  assert.equal((await rpc('delete_event', { p_event: ev.id, p_token: '0'.repeat(64) })).body, 'forbidden');
  assert.equal((await rpc('delete_participant', { p_event: ev.id, p_token: m.token, p_pid: m.pid })).body, 'forbidden');
  assert.equal((await rpc('update_event', { p_event: ev.id, p_token: ev.token, p_title: '新名稱', p_location_name: '台北', p_location_address: null })).body, 'ok');
  assert.equal((await rpc('get_event', { p_event: ev.id })).body.event.title, '新名稱');
  assert.equal((await rpc('admin_check', { p_event: ev.id, p_token: ev.token })).body, 'ok');
  assert.equal((await rpc('admin_check', { p_event: ev.id, p_token: m.token })).body, 'forbidden');
});

test('主理人密碼連錯 5 次鎖定，已登入的裝置不受影響', async () => {
  const e = await newEvent();
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await rpc('admin_login', { p_event: e.id, p_pin: '0000' }, { ip: freshIp() })).body.status);
  assert.deepEqual(statuses, ['wrong_pin', 'wrong_pin', 'wrong_pin', 'wrong_pin', 'locked']);
  const locked = (await rpc('admin_login', { p_event: e.id, p_pin: '4321' }, { ip: freshIp() })).body;
  assert.equal(locked.status, 'locked', '鎖定中正確密碼也不行');
  assert.ok(locked.until);
  assert.equal((await rpc('update_event', { p_event: e.id, p_token: e.token, p_title: '仍可操作', p_location_name: null, p_location_address: null })).body, 'ok');
});

test('鎖定時間每次加倍', () => {
  assert.equal(sql(`select string_agg(extract(epoch from private.lock_interval(l))::int::text, ',' order by l) from generate_series(0, 3) l`), '600,1200,2400,4800');
  assert.equal(sql(`select private.lock_interval(50) = interval '30 days'`), 't');
});

test('參與者密碼連錯 5 次鎖定', async () => {
  await join(ev.id, '鎖定測試', '1212');
  const s = [];
  for (let i = 0; i < 5; i++) s.push((await join(ev.id, '鎖定測試', '9999')).status);
  assert.equal(s.at(-1), 'locked');
  assert.equal((await join(ev.id, '鎖定測試', '1212')).status, 'locked');
});

test('舊版沒有密碼的成員：第一個設定密碼的人取得暱稱', async () => {
  sql(`insert into public.participants (event_id, pid, name, avail) values ('${ev.id}', 'legacy000001', '老王', '')`);
  assert.equal((await join(ev.id, '老王', '5555')).status, 'claimed');
  assert.equal((await join(ev.id, '老王', '6666')).status, 'wrong_pin');
});

test('主理人重設成員密碼：舊 token 失效，可以重新設定', async () => {
  const m = await join(ev.id, '重設測試', '1357');
  assert.equal((await rpc('reset_member_pin', { p_event: ev.id, p_token: ev.token, p_pid: m.pid })).body, 'ok');
  assert.equal((await rpc('save_availability', { p_event: ev.id, p_token: m.token, p_avail: 'Aw==' })).body, 'forbidden');
  assert.equal((await join(ev.id, '重設測試', '2468')).status, 'claimed');
});

test('登出後 token 失效', async () => {
  const e = await newEvent();
  assert.equal((await rpc('end_session', { p_event: e.id, p_token: e.token })).body, 'ok');
  assert.equal((await rpc('admin_check', { p_event: e.id, p_token: e.token })).body, 'forbidden');
});

test('移除成員會一併刪除他的密碼與登入', async () => {
  const m = await join(ev.id, '被移除', '1122');
  assert.equal((await rpc('delete_participant', { p_event: ev.id, p_token: ev.token, p_pid: m.pid })).body, 'ok');
  assert.equal(sql(`select count(*) from private.sessions where pid = '${m.pid}'`), '0');
  assert.equal(sql(`select count(*) from private.member_secrets where pid = '${m.pid}'`), '0');
});

test('刪除活動會一併刪除所有成員、密碼與登入', async () => {
  const e = await newEvent();
  await join(e.id, '甲', '1111');
  assert.equal((await rpc('delete_event', { p_event: e.id, p_token: e.token })).body, 'ok');
  assert.equal((await rpc('get_event', { p_event: e.id })).body, null);
  assert.equal(sql(`select (select count(*) from public.participants where event_id = '${e.id}') + (select count(*) from private.sessions where event_id = '${e.id}') + (select count(*) from private.event_secrets where event_id = '${e.id}')`), '0');
});

test('過期活動讀不到、也不能加入', async () => {
  const e = await newEvent();
  sql(`update public.events set expires_at = now() - interval '1 second' where id = '${e.id}'`);
  assert.equal((await rpc('get_event', { p_event: e.id })).body, null);
  assert.equal((await join(e.id, '遲到', '1111')).status, 'no_event');
});

test('每個活動最多 200 人', async () => {
  const e = await newEvent();
  sql(`insert into public.participants (event_id, pid, name) select '${e.id}', 'bulk' || lpad(g::text, 8, '0'), 'p' || g from generate_series(1, 200) g`);
  assert.equal((await join(e.id, '第201人', '1111')).status, 'too_many');
});

test('頻率限制：同一個 IP 一小時最多建立 10 個活動，偽造 x-forwarded-for 也繞不過', async () => {
  const ip = freshIp();
  for (let i = 0; i < 10; i++) await newEvent({}, ip);
  const blocked = await rpc('create_event', { p_title: 't', p_tz: 'UTC', p_dates: ['2026-12-01'], p_start: 0, p_end: 60, p_step: 30, p_duration: 30, p_pin: '1111' }, { ip });
  assert.match(errMsg(blocked), /rate_limited/);
  const spoof = await rpc('create_event', { p_title: 't', p_tz: 'UTC', p_dates: ['2026-12-01'], p_start: 0, p_end: 60, p_step: 30, p_duration: 30, p_pin: '1111' }, { ip, headers: { 'x-forwarded-for': '5.5.5.5' } });
  assert.match(errMsg(spoof), /rate_limited/);
});

test('IP 只以加鹽雜湊保存', () => {
  assert.equal(sql(`select bool_and(k ~ '^[0-9a-f]{64}$' or k like 'global|%') from private.rate_limits`), 't');
  assert.equal(sql(`select count(*) from private.rate_limits where k like '%10.%'`), '0');
});

test('輸入驗證', async () => {
  const base = { p_title: 't', p_tz: 'UTC', p_dates: ['2026-12-01'], p_start: 0, p_end: 60, p_step: 30, p_duration: 30, p_pin: '1111' };
  const cases = [
    [{ p_title: 'x'.repeat(61) }, 'bad_title'],
    [{ p_title: '   ' }, 'bad_title'],
    [{ p_pin: '12345' }, 'bad_pin'],
    [{ p_pin: 'abcd' }, 'bad_pin'],
    [{ p_duration: 90 }, 'bad_duration'],
    [{ p_dates: [] }, 'bad_dates'],
    [{ p_dates: ['2026-12-01; drop table events'] }, 'bad_dates'],
    [{ p_dates: Array.from({ length: 32 }, (_, i) => `2026-12-${String(i % 28 + 1).padStart(2, '0')}`) }, 'bad_dates'],
    [{ p_tz: 'Asia/Taipei; select 1' }, 'bad_tz'],
    [{ p_step: 20 }, 'bad_range'],
    [{ p_end: 0 }, 'bad_range'],
    [{ p_location_name: 'x'.repeat(81) }, 'bad_location']
  ];
  for (const [over, code] of cases) {
    const r = await rpc('create_event', { ...base, ...over }, { ip: freshIp() });
    assert.match(errMsg(r), new RegExp(code), JSON.stringify(over));
  }
  const longName = await rpc('join_event', { p_event: ev.id, p_name: 'x'.repeat(21), p_pin: '1111' });
  assert.match(errMsg(longName), /bad_name/);
  const badFinal = await rpc('finalize_event', { p_event: ev.id, p_token: ev.token, p_start: 1, p_slots: null });
  assert.match(errMsg(badFinal), /bad_range/);
});

test('定案與必到者設定', async () => {
  const m = await join(ev.id, '必到測試', '8080');
  assert.equal((await rpc('finalize_event', { p_event: ev.id, p_token: ev.token, p_start: 2, p_slots: 2 })).body, 'ok');
  assert.equal((await rpc('set_required', { p_event: ev.id, p_token: ev.token, p_pid: m.pid, p_required: true })).body, 'ok');
  const got = (await rpc('get_event', { p_event: ev.id })).body;
  assert.equal(got.event.final_start, 2);
  assert.equal(got.people.find(p => p.pid === m.pid).required, true);
});

test('即時同步只廣播「有變動」，不含資料，而且是公開頻道', () => {
  const rows = sql(`select topic || '|' || event || '|' || private from realtime.sent where topic = 'ev-${ev.id}' limit 1`);
  assert.equal(rows, `ev-${ev.id}|changed|false`);
});

test('密碼以 bcrypt 保存', () => {
  assert.equal(sql(`select bool_and(pin_hash like '$2a$08$%') from private.member_secrets`), 't');
  assert.equal(sql(`select bool_and(pin_hash like '$2a$08$%') from private.event_secrets where event_id = '${ev.id}'`), 't');
});
