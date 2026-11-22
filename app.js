"use strict";
/* 揪時間 — 前端主程式（純 JavaScript，不需要打包工具） */

/* ================= utilities ================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const COARSE = matchMedia('(pointer: coarse)').matches;
const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const WK = '日一二三四五六';
const hm = min => pad(Math.floor(min / 60)) + ':' + pad(min % 60);
const durLabel = m => m % 60 === 0 ? (m / 60) + ' 小時' : (m >= 60 ? (m / 60).toFixed(1).replace('.0', '') + ' 小時' : m + ' 分鐘');
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(ds, n) { const [y, m, d] = ds.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function dayInfo(ds) { const [y, m, d] = ds.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return { md: m + '/' + d, wk: WK[w], we: w === 0 || w === 6 }; }
const MAX_DAYS = 31;
const mdLabel = ds => { const [, m, d] = ds.split('-'); return `${+m}月${+d}日`; };
// 一個月為單位：開始日的「下個月同一天的前一天」；下個月沒有那一天就取下個月最後一天
// 例：11/11 → 12/10、1/31 → 2/28（閏年 2/29）、1/30 → 2/28（閏年 2/29）、11/1 → 11/30
function lastEndDate(a) {
  const [y, m, d] = a.split('-').map(Number);
  if (d === 1) { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return `${y}-${pad(m)}-${pad(last)}`; }
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d - 1, dim))}`;
}
function rangeProblem(a, b) {
  if (!a || !b) return '';
  if (b < a) return '結束日期要在開始日期之後。';
  const last = lastEndDate(a);
  if (b > last) return `日期範圍最多一個月，從 ${mdLabel(a)} 開始的話，結束日期不能晚於 ${mdLabel(last)}。`;
  return '';
}
function dateRange(a, b, max = 31) { const out = []; let cur = a; while (cur <= b && out.length < max) { out.push(cur); cur = addDays(cur, 1); } return out; }
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), ms))]); }

/* time zones: wall-clock time in the event's zone -> UTC ms */
const dtfCache = {};
function tzOffsetMin(ts, tz) {
  const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const p = {}; f.formatToParts(new Date(ts)).forEach(x => p[x.type] = x.value);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute);
  return Math.round((asUtc - Math.floor(ts / 60000) * 60000) / 60000);
}
function wallToUtc(ds, min, tz) {
  const [y, m, d] = ds.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, min);
  const off = tzOffsetMin(guess, tz); let ts = guess - off * 60000;
  const off2 = tzOffsetMin(ts, tz); if (off2 !== off) ts = guess - off2 * 60000;
  return ts;
}

/* bitset <-> base64 (storage format: one string per person) */
function enc(arr) { const b = new Uint8Array(Math.ceil(arr.length / 8)); for (let i = 0; i < arr.length; i++) if (arr[i]) b[i >> 3] |= 1 << (i & 7); let s = ''; b.forEach(x => s += String.fromCharCode(x)); return btoa(s); }
function dec(str, n) { const out = new Uint8Array(n); if (typeof str !== 'string' || !str) return out; let bin; try { bin = atob(str); } catch { return out; } for (let i = 0; i < n; i++) out[i] = ((bin.charCodeAt(i >> 3) || 0) >> (i & 7)) & 1; return out; }
const sum = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/* ================= backend (Supabase) ================= */
const CFG = window.JIU_CONFIG || {};
const CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !/YOUR_/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY));
const sb = (CONFIGURED && window.supabase) ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

const ERR_RE = /wrong_pin|locked|no_pin|too_many|no_event|rate_limited|forbidden|retry|bad_\w+|timeout/;
const errCode = e => { const m = String((e && (e.message || e.code)) || ''); return (ERR_RE.exec(m) || ['unknown'])[0]; };
const untilLabel = e => {
  const t = e && e.until ? new Date(e.until) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  return `${t.getMonth() + 1}/${t.getDate()} ${hm(t.getHours() * 60 + t.getMinutes())}`;
};
function pinErr(err) {
  const c = errCode(err);
  if (c === 'locked') { const u = untilLabel(err); return u ? `錯太多次了，已暫時鎖定到 ${u}。` : '錯太多次了，已暫時鎖定，請稍後再試。'; }
  return {
    wrong_pin: '密碼不正確。',
    no_pin: '這個活動沒有設定主理人密碼。',
    rate_limited: '嘗試太頻繁了，請過幾分鐘再試。',
    too_many: '這個活動的人數已達上限（200 人）。',
    no_event: '找不到這個活動，可能已被刪除。',
    retry: '剛好有人同時使用這個暱稱，請再按一次。',
    forbidden: '登入已失效，請重新登入。'
  }[c] || '';
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
async function rpcStatus(name, args) {
  const data = await rpc(name, args);
  if (data !== 'ok') throw new Error(String(data));
}
// 登入類函式回傳 { status, token, ... }；沒有 token 就是失敗
async function rpcLogin(name, args) {
  const r = (await rpc(name, args)) || {};
  if (r.token) return r;
  throw Object.assign(new Error(String(r.status || 'unknown')), { until: r.until });
}
const API = {
  load: id => rpc('get_event', { p_event: id }),
  createEvent: (ev, pin) => rpc('create_event', { p_title: ev.title, p_tz: ev.tz, p_dates: ev.dates, p_start: ev.startMin, p_end: ev.endMin, p_step: ev.step, p_duration: ev.duration, p_pin: pin, p_location_name: ev.locName || null, p_location_address: ev.locAddr || null }),
  adminLogin: (id, pin) => rpcLogin('admin_login', { p_event: id, p_pin: pin }),
  adminCheck: (id, token) => rpcStatus('admin_check', { p_event: id, p_token: token }),
  join: (id, name, pin) => rpcLogin('join_event', { p_event: id, p_name: name, p_pin: pin }),
  save: (id, token, avail, required) => rpcStatus('save_availability', { p_event: id, p_token: token, p_avail: enc(avail), p_required: required == null ? null : !!required }),
  endSession: (id, token) => rpc('end_session', { p_event: id, p_token: token }),
  updateEvent: (id, token, title, locName, locAddr) => rpcStatus('update_event', { p_event: id, p_token: token, p_title: title, p_location_name: locName, p_location_address: locAddr }),
  finalize: (id, token, start, slots) => rpcStatus('finalize_event', { p_event: id, p_token: token, p_start: start, p_slots: slots }),
  deleteEvent: (id, token) => rpcStatus('delete_event', { p_event: id, p_token: token }),
  setRequired: (id, token, pid, required) => rpcStatus('set_required', { p_event: id, p_token: token, p_pid: pid, p_required: required }),
  deleteMember: (id, token, pid) => rpcStatus('delete_participant', { p_event: id, p_token: token, p_pid: pid }),
  resetPin: (id, token, pid) => rpcStatus('reset_member_pin', { p_event: id, p_token: token, p_pid: pid })
};
// 登出時順便讓伺服器作廢 token；失敗也沒關係（token 只存在這台裝置）
function endSessionQuietly(id, token) { if (sb && token) API.endSession(id, token).catch(() => {}); }

/* ================= core model ================= */
function validEvent(v) {
  if (!v || typeof v !== 'object') return null;
  const dates = Array.isArray(v.dates) ? v.dates.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 31) : [];
  const step = [15, 30, 60].includes(v.step) ? v.step : 30;
  const s = Number(v.startMin), e = Number(v.endMin);
  if (!dates.length || !(s >= 0 && e <= 1440 && e > s) || (e - s) % step) return null;
  let tz = typeof v.tz === 'string' ? v.tz : 'Asia/Taipei';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; }
  let duration = Number(v.duration) || 120; duration = Math.max(step, Math.round(duration / step) * step);
  return { title: String(v.title || '未命名活動').slice(0, 60), tz, dates, startMin: s, endMin: e, step, duration,
    locName: String(v.locName || '').slice(0, 80), locAddr: String(v.locAddr || '').slice(0, 200) };
}
function eventFromRow(r) {
  return r && validEvent({ title: r.title, tz: r.tz, dates: r.dates, startMin: r.start_min, endMin: r.end_min, step: r.step, duration: r.duration, locName: r.location_name, locAddr: r.location_address });
}
function finalFromRow(r) {
  if (!r || r.final_start == null || !r.final_slots || !S.G) return null;
  const s = Math.trunc(Number(r.final_start) || 0), k = Math.trunc(Number(r.final_slots) || 0);
  if (s < 0 || k < 1 || s + k > S.G.N || Math.floor(s / S.G.rows) !== Math.floor((s + k - 1) / S.G.rows)) return null;
  return { start: s, k };
}
function geometry(ev) {
  const rows = (ev.endMin - ev.startMin) / ev.step, N = rows * ev.dates.length, utc = new Array(N);
  for (let d = 0; d < ev.dates.length; d++) for (let r = 0; r < rows; r++) utc[d * rows + r] = wallToUtc(ev.dates[d], ev.startMin + r * ev.step, ev.tz);
  return { rows, N, utc };
}
const slotDay = i => Math.floor(i / S.G.rows);
const slotMin = i => S.event.startMin + (i % S.G.rows) * S.event.step;
function slotLabel(i, slots = 1) { const di = dayInfo(S.event.dates[slotDay(i)]); return `${di.md}（${di.wk}）${hm(slotMin(i))}–${hm(slotMin(i) + slots * S.event.step)}`; }
function slotHTML(i, slots) { const di = dayInfo(S.event.dates[slotDay(i)]); return `${di.md}（${di.wk}）<span class="mono">${hm(slotMin(i))}–${hm(slotMin(i) + slots * S.event.step)}</span>`; }

/* best-slot ranking: per-person run length, window must not cross days, then non-max suppression */
function rankSlots(list, k, topN = 6, requireAll = false) {
  const ev = S.event, rows = S.G.rows, n = list.length;
  if (!n || k > rows) return [];
  const cands = [];
  for (let d = 0; d < ev.dates.length; d++) {
    const base = d * rows, W = rows - k + 1;
    const full = new Int32Array(W), part = new Float64Array(W);
    const ok = list.map(() => new Uint8Array(W)), some = list.map(() => new Uint8Array(W));
    list.forEach((p, ui) => {
      let run = 0, s = 0;
      for (let j = 0; j < rows; j++) {
        const v = p.avail[base + j];
        run = v ? run + 1 : 0; s += v; if (j >= k) s -= p.avail[base + j - k];
        if (j >= k - 1) { const w = j - k + 1; if (run >= k) { full[w]++; ok[ui][w] = 1; } if (s > 0) some[ui][w] = 1; part[w] += s / k; }
      }
    });
    for (let w = 0; w < W; w++) {
      if (part[w] === 0) continue;
      cands.push({ start: base + w, day: d, row: w, full: full[w], part: part[w],
        partial: list.filter((_, ui) => !ok[ui][w] && some[ui][w]).map(p => p.name),
        absent: list.filter((_, ui) => !some[ui][w]).map(p => p.name),
        reqMissing: list.filter((p, ui) => p.required && !ok[ui][w]).map(p => p.name) });
    }
  }
  cands.sort((a, b) => b.full - a.full || b.part - a.part || a.start - b.start);
  const picked = [];
  for (const c of cands) {
    if (requireAll && c.reqMissing.length) continue; if (picked.every(p => p.day !== c.day || Math.abs(p.row - c.row) >= k)) picked.push(c); if (picked.length >= topN) break; }
  return picked;
}

/* ================= state ================= */
const S = {
  reqMode: 'req',
  event: null, id: null, src: null, G: null, final: null, admin: null,
  people: new Map(), me: null, mine: null, mineLoaded: false, peopleLoaded: false,
  tab: 'edit', page: 0, per: 1, paintTouch: true, brush: 'rect',
  undo: null, dur: 120, hl: null, sel: null, channel: null, grid: null, dragging: false,
  saveText: '', liveOk: false, prefillName: ''
};
// 剛建立活動時的主理人密碼：只留在記憶體裡顯示一次，不寫進瀏覽器儲存空間
let freshPin = '';

function peopleList() {
  const arr = [];
  S.people.forEach((p, pid) => {
    const mine = S.me && pid === S.me.pid;
    arr.push({ pid, name: mine && S.me.name ? S.me.name : p.name, avail: mine ? S.mine : p.avail, required: mine ? !!S.me.required : !!p.required });
  });
  if (S.me && S.me.name && !S.people.has(S.me.pid) && (sum(S.mine) > 0 || S.me.required)) arr.push({ pid: S.me.pid, name: S.me.name, avail: S.mine, required: !!S.me.required });
  return arr;
}
const filledList = () => peopleList().filter(p => sum(p.avail) > 0);
const requiredFilled = () => filledList().filter(p => p.required);
const reqActive = () => S.reqMode === 'req' && requiredFilled().length > 0;
const personRow = r => ({ name: String(r.name || '').slice(0, 20), avail: dec(r.avail, S.G.N), required: !!r.required });

/* ================= routing (?e=房間代碼) ================= */
const BASE = location.origin + location.pathname;
const eventUrl = id => `${BASE}?e=${id}`;
function navigate(qs) { history.pushState(null, '', qs ? BASE + qs : BASE); void route(); }
addEventListener('popstate', route);
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]'); if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault(); navigate(a.getAttribute('href').replace(/^\.\//, ''));
});

function route() {
  closeSheet();
  const q = new URLSearchParams(location.search);
  const id = (q.get('e') || '').toLowerCase();
  if (q.has('demo')) return openDemo();
  if (/^[a-z0-9]{6,16}$/.test(id)) {
    if (q.has('admin') || q.has('p') || q.has('k')) history.replaceState(null, '', eventUrl(id));
    return openEvent(id);
  }
  showHome();
}

function cleanup() {
  if (S.channel) { sb.removeChannel(S.channel).catch(() => {}); S.channel = null; }
  clearInterval(pollTimer); pollTimer = 0;
  S.event = null; S.grid = null; S.id = null; S.liveOk = false;
  setNoIndex(false);
}
// 活動頁不讓搜尋引擎收錄（活動連結就是進入的鑰匙）
function setNoIndex(on) {
  let m = document.querySelector('meta[name="robots"]');
  if (on && !m) { m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow'; document.head.appendChild(m); }
  else if (!on && m) m.remove();
}

/* ================= home ================= */
function showHome() {
  cleanup();
  document.title = '揪時間｜手機也好填的多人時間協調';
  $('#evTitle').textContent = ''; $('#tabs').hidden = true; $('#shareBtn').hidden = true; $('#adminBtn').hidden = true; renderToolbar();
  const t1 = addDays(ymd(new Date()), 1), t5 = addDays(t1, 4);
  const hours = Array.from({ length: 25 }, (_, h) => h);
  const mini = [[.2, .4, .2, 0, .2], [.4, .6, .4, .2, .4], [.6, .8, .6, .4, .2], [.8, 1, .8, .6, .4], [.6, 1, .6, .8, .2], [.4, .6, .2, .4, 0]];
  const recent = (store.get('jsj:recent') || []).slice(0, 6);
  $('#main').innerHTML = `
  <section class="hero">
    <div>
      <p class="eyebrow">多人時間協調</p>
      <h1>揪時間</h1>
      <p class="lede">開一個房間、丟出連結，大家在手機上拖一拖就能填好有空的時段。系統會自動排出最多人能全程參加的時間。</p>
    </div>
    <div class="mini" aria-hidden="true">${mini.map((r, ri) => `<b>${18 + ri}</b>` + r.map((p, ci) => `<i data-p="${p}" class="${ri >= 3 && ri <= 4 && ci === 1 ? 'best' : ''}"></i>`).join('')).join('')}</div>
  </section>
  ${CONFIGURED ? '' : `<div class="setup mb">還沒設定資料庫，目前只能試玩範例。請依照 README 建立 Supabase 專案，並把網址和金鑰填進 <code>config.js</code>。</div>`}
  <div class="home-grid">
    <form class="card" id="createForm" novalidate>
      <h2>建立新活動</h2>
      <label class="field"><span>活動名稱</span><input type="text" id="fTitle" maxlength="60" placeholder="例如：期末專題討論" required></label>
      <div class="two">
        <label class="field"><span>地點（選填）</span><input type="text" id="fLocName" maxlength="80" placeholder="例如：學校餐廳二樓"></label>
        <label class="field"><span>地址（選填，可開地圖）</span><input type="text" id="fLocAddr" maxlength="200" placeholder="例如：台北市大安區羅斯福路四段1號"></label>
      </div>
      <div class="two">
        <label class="field"><span>開始日期</span><input type="date" id="fStart" value="${t1}"></label>
        <label class="field"><span>結束日期（最多一個月）</span><input type="date" id="fEnd" value="${t5}" min="${t1}" max="${lastEndDate(t1)}"></label>
      </div>
      <p class="err range-err" id="rangeMsg" role="alert" hidden></p>
      <div class="two">
        <label class="field"><span>每天從</span><select id="fFrom">${hours.slice(0, 24).map(h => `<option value="${h * 60}" ${h === 9 ? 'selected' : ''}>${pad(h)}:00</option>`).join('')}</select></label>
        <label class="field"><span>到</span><select id="fTo">${hours.slice(1).map(h => `<option value="${h * 60}" ${h === 22 ? 'selected' : ''}>${pad(h)}:00</option>`).join('')}</select></label>
      </div>
      <div class="two">
        <label class="field"><span>格子大小</span><select id="fStep"><option value="15">15 分鐘</option><option value="30" selected>30 分鐘</option><option value="60">1 小時</option></select></label>
        <label class="field"><span>預計活動長度</span><select id="fDur">${[30, 60, 90, 120, 180, 240].map(m => `<option value="${m}" ${m === 120 ? 'selected' : ''}>${durLabel(m)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>主理人密碼（4 位數字）</span><input type="password" id="fPin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="new-password" placeholder="例如：2580" class="mono"></label>
      <p class="note">之後在活動頁按「主理人」輸入這組密碼，就能修改活動資訊、定案時段、刪除活動。時區：${esc(BROWSER_TZ)}。</p>
      <button class="btn primary big" type="submit" id="createBtn" ${CONFIGURED ? '' : 'disabled'}>建立並取得連結</button>
      <p class="err" id="createMsg" hidden></p>
    </form>
    <div class="side">
      <div class="card">
        <h2>先試玩看看</h2>
        <p>用 5 位範例成員的資料，體驗手機劃記、熱力圖與最佳時段推薦。範例不會儲存。</p>
        <a class="btn" href="?demo" data-nav>開啟範例活動</a>
      </div>
      <div class="card privacy"><h2>隱私說明</h2><p class="note">不需要註冊，不收集 email、電話或真實姓名。只儲存活動資訊、你輸入的暱稱與勾選的時段；密碼以單向雜湊保存，連我們也看不到。活動建立 90 天後連同所有填寫自動刪除。為了防止濫用，連線 IP 只以加鹽雜湊形式暫存，1 天內刪除。</p></div>
      ${recent.length ? `<div class="card"><h2>最近開過的活動</h2><ul class="recent">${recent.map(r => `<li><a href="?e=${esc(r.id)}" data-nav><span>${esc(r.title)}</span><span class="mono">${store.get('jsj:admin:' + r.id) || store.get('jsj:pin:' + r.id) ? '主理人' : ''}</span></a><button class="rm" type="button" data-rm-recent="${esc(r.id)}" aria-label="從列表移除 ${esc(r.title)}">×</button></li>`).join('')}</ul><p class="note">移除只會從這個列表拿掉，活動和連結都還在。</p></div>` : ''}
    </div>
  </div>`;
  document.querySelectorAll('.mini i[data-p]').forEach(el => el.style.setProperty('--p', el.dataset.p));
  $('#createForm').addEventListener('submit', onCreate);
  const fS = $('#fStart'), fE = $('#fEnd');
  const rMsg = $('#rangeMsg');
  const checkRange = () => {
    if (fS.value) { fE.min = fS.value; fE.max = lastEndDate(fS.value); }
    const t = rangeProblem(fS.value, fE.value);
    rMsg.textContent = t; rMsg.hidden = !t; fE.classList.toggle('bad', !!t);
  };
  ['change', 'input'].forEach(ev => { fS.addEventListener(ev, checkRange); fE.addEventListener(ev, checkRange); });
  document.querySelectorAll('[data-rm-recent]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.rmRecent, all = store.get('jsj:recent') || [], item = all.find(x => x.id === id);
    store.set('jsj:recent', all.filter(x => x.id !== id)); showHome();
    if (item) toast(`已從列表移除「${item.title}」`, { label: '復原', run: () => { const cur = (store.get('jsj:recent') || []).filter(x => x.id !== id); cur.splice(all.indexOf(item), 0, item); store.set('jsj:recent', cur); showHome(); } });
  }));
}
async function onCreate(e) {
  e.preventDefault();
  const msg = $('#createMsg'), fail = t => { msg.textContent = t; msg.hidden = false; };
  const title = $('#fTitle').value.trim();
  const a = $('#fStart').value, b = $('#fEnd').value;
  const from = +$('#fFrom').value, to = +$('#fTo').value, step = +$('#fStep').value, dur = +$('#fDur').value;
  if (!title) return fail('請輸入活動名稱。');
  if (!a || !b) return fail('請選擇開始和結束日期。');
  const rp = rangeProblem(a, b);
  if (rp) { fail(rp); $('#fEnd').focus(); return; }
  const dates = dateRange(a, b, MAX_DAYS);
  if (to <= from) return fail('每天的結束時間要晚於開始時間。');
  if (dur > to - from) return fail('活動長度比每天的時間範圍還長。');
  const pin = $('#fPin').value.trim();
  if (!/^\d{4}$/.test(pin)) return fail('主理人密碼請輸入 4 位數字。');
  const ev = { title, tz: BROWSER_TZ, dates, startMin: from, endMin: to, step, duration: dur, locName: $('#fLocName').value.trim(), locAddr: $('#fLocAddr').value.trim() };
  const btn = $('#createBtn'); btn.disabled = true; btn.textContent = '建立中…';
  let res = null;
  try { res = await withTimeout(API.createEvent(ev, pin), 15000); }
  catch (err) {
    btn.disabled = false; btn.textContent = '建立並取得連結';
    return fail(errCode(err) === 'rate_limited' ? '建立活動太頻繁了，請過一陣子再試。' : '建立失敗，請檢查網路後再試一次。（' + errCode(err) + '）');
  }
  const id = res && typeof res.id === 'string' && /^[a-z0-9]{6,16}$/.test(res.id) ? res.id : '';
  if (!id || !res.token) { btn.disabled = false; btn.textContent = '建立並取得連結'; return fail('建立失敗，請再試一次。'); }
  store.set('jsj:admin:' + id, res.token);
  store.set('jsj:new:' + id, 1);
  freshPin = pin;
  navigate('?e=' + id);
}
function addRecent(id, title) {
  const r = (store.get('jsj:recent') || []).filter(x => x.id !== id);
  r.unshift({ id, title }); store.set('jsj:recent', r.slice(0, 8));
}

/* ================= open event ================= */
async function openEvent(id) {
  cleanup();
  $('#tabs').hidden = true; $('#shareBtn').hidden = true; $('#adminBtn').hidden = true; renderToolbar();
  $('#evTitle').textContent = '';
  if (!sb) { $('#main').innerHTML = `<div class="empty"><p>這個網站還沒設定資料庫，無法開啟房間。</p><p><a class="btn" href="./" data-nav>回首頁</a></p></div>`; return; }
  $('#main').innerHTML = `<div class="empty">正在開啟活動…</div>`;
  setNoIndex(true);
  let data = null;
  try { data = await withTimeout(API.load(id), 12000); }
  catch (err) {
    if (new URLSearchParams(location.search).get('e') !== id) return;
    $('#main').innerHTML = errCode(err) === 'rate_limited' ? `<div class="empty"><p>連線太頻繁了，請過一分鐘再重新整理。</p></div>` : `<div class="empty"><p>連線失敗，請確認網路後重新整理。</p></div>`;
    return;
  }
  if (new URLSearchParams(location.search).get('e') !== id) return;
  const row = data && data.event, people = data && Array.isArray(data.people) ? data.people : [];
  const ev = eventFromRow(row);
  if (!ev) { $('#main').innerHTML = `<div class="empty"><p>找不到這個活動，可能連結打錯了，或活動已被刪除（活動建立 90 天後會自動刪除）。</p><p><a class="btn" href="./" data-nav>回首頁</a></p></div>`; return; }
  setupEvent(id, ev, 'shared', row, people);
}
function setupEvent(id, ev, src, row, people) {
  S.id = id; S.event = ev; S.src = src; S.G = geometry(ev);
  S.people = new Map(); S.mine = new Uint8Array(S.G.N); S.mineLoaded = false;
  const saved = src === 'demo' ? null : store.get('jsj:me:' + id);
  const hasToken = saved && typeof saved.token === 'string' && saved.token.length === 64;
  S.me = hasToken && saved.name ? { name: String(saved.name).slice(0, 20), pid: typeof saved.pid === 'string' ? saved.pid : null, token: saved.token } : null;
  // 舊版只記暱稱、沒有登入憑證：保留暱稱方便重新輸入密碼
  S.prefillName = !S.me && saved && saved.name ? String(saved.name).slice(0, 20) : '';
  if (!S.me && saved) store.del('jsj:me:' + id);
  S.admin = src === 'demo' ? null : store.get('jsj:admin:' + id);
  S.undo = null;
  S.tab = 'edit'; S.page = 0; S.dur = ev.duration; S.hl = null; S.sel = null; S.saveText = '';
  S.final = finalFromRow(row);
  if (src === 'demo') { demoPeople(); S.saveText = '範例模式，不會儲存'; }
  else { applyPeople(people); subscribe(id); addRecent(id, ev.title); void checkAdmin(id); }
  S.mineLoaded = true; S.peopleLoaded = true;
  document.title = ev.title + '｜揪時間';
  renderEvent();
  if (store.get('jsj:new:' + id)) { store.del('jsj:new:' + id); openShare(true); }
}
const findByName = name => [...S.people.entries()].find(([, p]) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
// 主理人：確認登入是否仍有效；舊版存在瀏覽器的密碼換成登入憑證後就刪掉
async function checkAdmin(id) {
  const legacyPin = store.get('jsj:pin:' + id);
  if (legacyPin && !S.admin) {
    try { const r = await API.adminLogin(id, String(legacyPin)); if (S.id !== id) return; S.admin = r.token; store.set('jsj:admin:' + id, r.token); renderEvent(); }
    catch (err) { if (errCode(err) === 'timeout' || errCode(err) === 'unknown') return; }
    store.del('jsj:pin:' + id);
    return;
  }
  if (!S.admin) return;
  try { await API.adminCheck(id, S.admin); }
  catch (err) { if (S.id === id && errCode(err) === 'forbidden') dropAdmin(); }
}
function dropAdmin() { S.admin = null; store.del('jsj:admin:' + S.id); store.del('jsj:pin:' + S.id); refresh(true); }
const findByPid = pid => (S.people.has(pid) ? [pid, S.people.get(pid)] : null);
function applyPeople(rows) {
  S.people = new Map();
  rows.forEach(r => { if (r && typeof r.pid === 'string') S.people.set(r.pid, personRow(r)); });
  if (S.me) {
    const hit = S.me.pid ? findByPid(S.me.pid) : findByName(S.me.name);
    if (hit) { const first = !S.me.pid; S.me.pid = hit[0]; S.me.name = hit[1].name; if (!S.me.reqDirty) S.me.required = hit[1].required; if (first || !S.mineLoaded) S.mine = hit[1].avail.slice(); }
    else if (S.me.pid && !pendingSave && !saving) memberRemoved();
  }
}
// 即時同步：資料庫只廣播「這個活動有變動」（不含任何資料），收到後再重新讀取。
// 廣播頻道任何知道活動代碼的人都能送訊息，所以只當成提示，而且限制重新讀取的頻率。
let pollTimer = 0, resyncTimer = 0, lastResync = 0;
function subscribe(id) {
  S.channel = sb.channel('ev-' + id)
    .on('broadcast', { event: 'changed' }, () => { if (S.id === id) scheduleResync(); })
    .subscribe(status => {
      if (S.id !== id) return;
      if (status === 'SUBSCRIBED') { S.liveOk = true; scheduleResync(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { S.liveOk = false; }
    });
  // 即時連線斷掉時，每 20 秒重新讀取一次
  pollTimer = setInterval(() => { if (!S.liveOk && document.visibilityState === 'visible') scheduleResync(); }, 20000);
}
function scheduleResync() {
  if (resyncTimer) return;
  const wait = Math.max(300, 2000 - (Date.now() - lastResync));
  resyncTimer = setTimeout(() => { resyncTimer = 0; void resync(); }, wait);
}
async function resync() {
  if (!S.id || S.src !== 'shared') return;
  const id = S.id;
  lastResync = Date.now();
  try {
    const data = await API.load(id);
    if (S.id !== id) return;
    if (!data || !data.event) { eventGone(); return; }
    applyPeople(Array.isArray(data.people) ? data.people : []); applyEventRow(data.event); refresh(true);
  } catch { /* 網路暫時不通：下次變動或回到頁面時會再同步 */ }
}
function memberRemoved() {
  S.me = null; S.prefillName = ''; S.mine = new Uint8Array(S.G.N); S.undo = null; S.saveText = '';
  if (S.src !== 'demo') store.del('jsj:me:' + S.id);
  closeSheet(); renderEvent(); toast('主理人已將你移出這個活動，可以重新輸入暱稱填寫');
}
function applyEventRow(row) {
  const ev = eventFromRow(row); if (!ev) return;
  S.event.title = ev.title; S.event.locName = ev.locName; S.event.locAddr = ev.locAddr;
  S.final = finalFromRow(row);
  document.title = ev.title + '｜揪時間';
}
function forgetEvent(id) {
  store.del('jsj:pin:' + id); store.del('jsj:admin:' + id); store.del('jsj:me:' + id);
  store.set('jsj:recent', (store.get('jsj:recent') || []).filter(x => x.id !== id));
}
function eventGone() {
  const id = S.id; forgetEvent(id); cleanup(); closeSheet();
  $('#tabs').hidden = true; $('#shareBtn').hidden = true; $('#adminBtn').hidden = true; $('#evTitle').textContent = ''; renderToolbar();
  $('#main').innerHTML = `<div class="empty"><p>這個活動已經被主理人刪除了。</p><p><a class="btn" href="./" data-nav>回首頁</a></p></div>`;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleResync(); });

/* ================= demo data ================= */
function openDemo() {
  cleanup();
  const t1 = addDays(ymd(new Date()), 1);
  const ev = validEvent({ title: '期末專題討論（範例）', tz: BROWSER_TZ, dates: dateRange(t1, addDays(t1, 4)), startMin: 540, endMin: 1320, step: 30, duration: 120 });
  setupEvent('demo', ev, 'demo', null, []);
}
function demoPeople() {
  let seed = 20261110; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rows = S.G.rows, names = ['小安', '阿哲', 'Mia', '宇辰', '佳穎'];
  const rowOf = min => (min - S.event.startMin) / S.event.step;
  names.forEach((name, pi) => {
    const a = new Uint8Array(S.G.N);
    S.event.dates.forEach((_, d) => {
      const blocks = 1 + Math.floor(rnd() * 2);
      for (let b = 0; b < blocks; b++) {
        const s = Math.floor(rnd() * (rows - 4)), len = 3 + Math.floor(rnd() * 8);
        for (let r = s; r < Math.min(rows, s + len); r++) a[d * rows + r] = 1;
      }
    });
    for (let r = rowOf(1110); r < rowOf(1260); r++) a[2 * rows + r] = 1;
    if (pi === 3) a[2 * rows + rowOf(1110)] = 0;
    for (let r = rowOf(840); r < rowOf(960); r++) if (pi !== 1) a[1 * rows + r] = 1;
    S.people.set('demo' + pi, { name, avail: a, required: pi === 0 || pi === 2 });
  });
}

/* ================= event rendering ================= */
function renderEvent() {
  if (!S.event) return;
  $('#evTitle').textContent = S.event.title;
  $('#shareBtn').hidden = S.src === 'demo';
  const ab = $('#adminBtn'); ab.hidden = S.src === 'demo'; ab.textContent = S.admin ? '主理人 ✓' : '主理人';
  $('#tabs').hidden = false;
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  $('#ctHeat').textContent = filledList().length || '';
  const m = $('#main');
  if (S.tab === 'edit') renderEdit(m); else if (S.tab === 'heat') renderHeat(m); else renderBest(m);
  renderToolbar();
}
function refresh(full) {
  if (!S.event || S.dragging) return;
  $('#ctHeat').textContent = filledList().length || '';
  if (S.tab === 'edit' && !full) { paintCells(); const st = $('#saveStatus'); if (st) st.textContent = S.saveText; return; }
  if (S.tab === 'edit' && document.activeElement && document.activeElement.id === 'nameInput') return;
  const y = scrollY; renderEvent(); scrollTo(0, y);
  if (S.tab === 'heat' && S.sel != null) showDetail(S.sel);
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => { S.tab = b.dataset.tab; S.sel = null; closeSheet(); if (S.tab !== 'heat') S.hl = null; renderEvent(); }));

function tzNote() { return S.event.tz !== BROWSER_TZ ? `<p class="tzline">時間以活動時區 ${esc(S.event.tz)} 顯示</p>` : ''; }
const mapsUrl = ev => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.locAddr || ev.locName);
function infoHTML() {
  const ev = S.event; if (!ev.locName && !ev.locAddr) return '';
  return `<div class="place"><span class="lbl">地點</span>
    <div class="place-body"><div>${ev.locName ? `<b>${esc(ev.locName)}</b>` : ''}${ev.locAddr ? `<div class="addr">${esc(ev.locAddr)}</div>` : ''}</div>
    <a class="btn sm" href="${esc(mapsUrl(ev))}" target="_blank" rel="noopener noreferrer">Google 地圖</a></div></div>`;
}
function reqToggleHTML() {
  const reqs = peopleList().filter(p => p.required); if (!reqs.length) return '';
  const filled = reqs.filter(p => sum(p.avail) > 0), pending = reqs.filter(p => sum(p.avail) === 0);
  return `<div class="reqbar">
    <div class="seg" role="group" aria-label="必到者"><button type="button" data-rm="req" aria-pressed="${S.reqMode === 'req'}">考慮必到者</button><button type="button" data-rm="all" aria-pressed="${S.reqMode === 'all'}">全體</button></div>
    <span class="note">必到者：${reqs.map(p => esc(p.name)).join('、')}${pending.length ? `（${pending.map(p => esc(p.name)).join('、')} 還沒填）` : ''}</span>
  </div>`;
}
function bindReqToggle(root) { root.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { S.reqMode = b.dataset.rm; renderEvent(); })); }
const nameChip = (p, extra = '') => `<span class="chip ${extra}${S.me && p.pid === S.me.pid ? ' me' : ''}${p.required ? ' req' : ''}">${esc(p.name)}${p.required ? '<i>必到</i>' : ''}</span>`;
function modeBanner() { return S.src === 'demo' ? `<div class="banner">這是範例活動，成員與資料都是示範用，你的劃記不會被儲存。</div>` : ''; }

/* --- finalized slot + export to Apple / Google calendar --- */
function finalHTML() {
  if (!S.final) return '';
  return `<div class="final">
    <div><span class="lbl">已定案</span><div class="when">${slotHTML(S.final.start, S.final.k)}</div></div>
    ${S.admin ? `<div class="actions"><button class="btn sm primary" type="button" id="copyAnn">複製公告文字</button><button class="link" type="button" id="unfinal">取消定案</button></div>` : ''}
  </div>`;
}
function announcement() {
  const ev = S.event, lines = [`【${ev.title}】時間定好了！`, `時間：${slotLabel(S.final.start, S.final.k)}`];
  if (ev.locName || ev.locAddr) lines.push(`地點：${[ev.locName, ev.locAddr].filter(Boolean).join('／')}`);
  if (ev.locAddr || ev.locName) lines.push(`地圖：${mapsUrl(ev)}`);
  lines.push(`詳情：${eventUrl(S.id)}`);
  return lines.join('\n');
}
function openAnnouncement() {
  const text = announcement();
  const s = openSheet(`<div class="sh-h"><h3>公告文字</h3><button class="x" type="button" aria-label="關閉">×</button></div>
    <pre class="ann" id="annText">${esc(text)}</pre>
    <div class="actions"><button class="btn primary" type="button" id="copyAnnBtn">複製</button>${navigator.share ? `<button class="btn" type="button" id="shareAnnBtn">分享到其他 App</button>` : ''}</div>`);
  $('#copyAnnBtn', s).addEventListener('click', () => copyText(text, '已複製，貼到 LINE 或群組就好', '#annText'));
  const sh = $('#shareAnnBtn', s); if (sh) sh.addEventListener('click', () => navigator.share({ text }).catch(() => {}));
}
function bindFinal(root) {
  const u = $('#unfinal', root); if (u) u.addEventListener('click', () => setFinal(null));
  const c = $('#copyAnn', root); if (c) c.addEventListener('click', openAnnouncement);
}
function adminFail(err) {
  const c = errCode(err);
  if (c === 'forbidden') { dropAdmin(); closeSheet(); toast('主理人登入已失效，請重新登入'); return; }
  toast(pinErr(err) || '操作失敗，請再試一次');
}
async function setFinal(c) {
  if (!S.admin) return;
  const prev = S.final;
  S.final = c; refresh(true);
  try { await API.finalize(S.id, S.admin, c ? c.start : null, c ? c.k : null); toast(c ? '已定案！按「複製公告文字」就能貼到群組' : '已取消定案'); if (c) openAnnouncement(); }
  catch (err) { S.final = prev; adminFail(err); }
}

/* --- organizer panel --- */
function openAdmin() {
  if (!S.event || S.src === 'demo') return;
  if (!S.admin) {
    const s = openSheet(`<div class="sh-h"><h3>主理人登入</h3><button class="x" type="button" aria-label="關閉">×</button></div>
      <form class="sheet-form" id="pinForm">
        <label class="lbl" for="pinInput">輸入建立活動時設定的 4 位數密碼</label>
        <input type="password" id="pinInput" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" class="pin">
        <button class="btn primary" type="submit" id="pinBtn">登入</button>
        <p class="err" id="pinMsg" hidden></p>
      </form>`);
    const inp = $('#pinInput', s); setTimeout(() => inp.focus(), 50);
    $('#pinForm', s).addEventListener('submit', async e => {
      e.preventDefault();
      const pin = inp.value.trim(), msg = $('#pinMsg', s), btn = $('#pinBtn', s);
      if (!/^\d{4}$/.test(pin)) { msg.textContent = '請輸入 4 位數字。'; msg.hidden = false; return; }
      btn.disabled = true;
      try { const r = await API.adminLogin(S.id, pin); S.admin = r.token; store.set('jsj:admin:' + S.id, r.token); store.del('jsj:pin:' + S.id); closeSheet(); renderEvent(); toast('已用主理人身份登入'); openAdmin(); }
      catch (err) { btn.disabled = false; msg.textContent = pinErr(err) || '連線失敗，請再試一次。'; msg.hidden = false; inp.select(); }
    });
    return;
  }
  const ev = S.event;
  const s = openSheet(`<div class="sh-h"><h3>主理人</h3><button class="x" type="button" aria-label="關閉">×</button></div>
    <form class="sheet-form" id="infoForm">
      <label class="field"><span>活動名稱</span><input type="text" id="eTitle" maxlength="60" value="${esc(ev.title)}"></label>
      <label class="field"><span>地點（選填）</span><input type="text" id="eLocName" maxlength="80" value="${esc(ev.locName)}" placeholder="例如：學校餐廳二樓"></label>
      <label class="field"><span>地址（選填，可開地圖）</span><input type="text" id="eLocAddr" maxlength="200" value="${esc(ev.locAddr)}" placeholder="例如：台北市大安區羅斯福路四段1號"></label>
      <button class="btn primary" type="submit" id="infoBtn">儲存活動資訊</button>
    </form>
    <p class="note">到「最佳時段」可以把推薦的時段定案，定案後就能複製公告文字。</p>
    <div class="sheet-form"><span class="lbl">成員（${S.people.size} 人）</span>
      ${S.people.size ? `<ul class="members">${[...S.people.entries()].map(([pid, p]) => `<li>
        <span class="m-name">${esc(p.name)}${sum(p.avail) ? '' : '<i>未劃記</i>'}</span>
        <label class="check inline"><input type="checkbox" data-req="${esc(pid)}" ${p.required ? 'checked' : ''}> 必到</label>
        <button class="link" type="button" data-reset="${esc(pid)}">重設密碼</button>
        <button class="link danger-link" type="button" data-kick="${esc(pid)}">移除</button></li>`).join('')}</ul>` : '<p class="note">還沒有人填寫。</p>'}
      <p class="note">成員忘記個人密碼時，按「重設密碼」，他下次輸入同一個暱稱就能設定新密碼（填好的時間會保留）。</p>
    </div>
    <details><summary>刪除活動</summary>
      <p class="note">刪除後所有人的填寫都會消失，無法復原。</p>
      <div class="actions"><button class="btn sm danger" type="button" id="delBtn">刪除這個活動</button></div>
    </details>
    <div class="actions"><button class="link" type="button" id="logoutBtn">登出主理人</button></div>`);
  $('#infoForm', s).addEventListener('submit', async e => {
    e.preventDefault();
    const title = $('#eTitle', s).value.trim(), locName = $('#eLocName', s).value.trim(), locAddr = $('#eLocAddr', s).value.trim();
    if (!title) return toast('活動名稱不能空白');
    const btn = $('#infoBtn', s); btn.disabled = true;
    try { await API.updateEvent(S.id, S.admin, title, locName, locAddr); Object.assign(S.event, { title, locName, locAddr }); addRecent(S.id, title); document.title = title + '｜揪時間'; closeSheet(); renderEvent(); toast('已更新活動資訊'); }
    catch (err) { btn.disabled = false; adminFail(err); }
  });
  s.querySelectorAll('[data-req]').forEach(cb => cb.addEventListener('change', async () => {
    const pid = cb.dataset.req, val = cb.checked, p = S.people.get(pid); if (!p) return;
    cb.disabled = true;
    try { await API.setRequired(S.id, S.admin, pid, val); p.required = val; if (S.me && S.me.pid === pid) { S.me.required = val; S.me.reqDirty = false; } refresh(true); toast(val ? `已將 ${p.name} 設為必到者` : `已取消 ${p.name} 的必到`); }
    catch (err) { cb.checked = !val; adminFail(err); }
    cb.disabled = false;
  }));
  s.querySelectorAll('[data-kick]').forEach(btn => btn.addEventListener('click', async () => {
    const pid = btn.dataset.kick, p = S.people.get(pid); if (!p) return;
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '確定移除？'; return; }
    btn.disabled = true;
    try { await API.deleteMember(S.id, S.admin, pid); const wasMe = S.me && S.me.pid === pid; S.people.delete(pid); if (wasMe) memberRemoved(); else { refresh(true); openAdmin(); } toast(`已移除 ${p.name}`); }
    catch (err) { btn.disabled = false; adminFail(err); }
  }));
  s.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', async () => {
    const pid = btn.dataset.reset, p = S.people.get(pid); if (!p) return;
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '確定重設？'; return; }
    btn.disabled = true;
    try { await API.resetPin(S.id, S.admin, pid); btn.textContent = '已重設'; toast(`已重設 ${p.name} 的密碼，請他重新輸入暱稱並設定新密碼`); }
    catch (err) { btn.disabled = false; adminFail(err); }
  }));
  const del = $('#delBtn', s);
  del.addEventListener('click', async () => {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '確定刪除？再按一次'; return; }
    del.disabled = true;
    try { await API.deleteEvent(S.id, S.admin); const id = S.id; forgetEvent(id); closeSheet(); navigate(''); toast('活動已刪除'); }
    catch (err) { del.disabled = false; adminFail(err); }
  });
  $('#logoutBtn', s).addEventListener('click', () => { endSessionQuietly(S.id, S.admin); S.admin = null; store.del('jsj:admin:' + S.id); store.del('jsj:pin:' + S.id); closeSheet(); renderEvent(); toast('已登出主理人'); });
}

/* --- edit tab --- */
function joinHTML() {
  const demo = S.src === 'demo';
  return `<form class="join" id="joinForm">
    <label for="nameInput">輸入暱稱${demo ? '' : '和 4 位數個人密碼'}開始填寫</label>
    <div class="row"><input type="text" id="nameInput" maxlength="20" placeholder="例如：小明" autocomplete="nickname" value="${esc(S.prefillName || '')}">${demo ? '' : `<input type="password" id="joinPin" class="mono pin-sm" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="密碼" aria-label="4 位數個人密碼">`}<button class="btn primary" type="submit" id="joinBtn">開始填寫</button></div>
    <label class="check"><input type="checkbox" id="reqInput"> 我是必到者（我沒空就不排這個時間）</label>
    <p class="note">${demo ? '範例模式不需要密碼。' : '第一次填寫時自己設一組 4 位數密碼，之後換手機輸入同樣的暱稱和密碼就能回來修改；別人不知道密碼就改不了你的時間。忘記密碼可以請主理人重設。'}</p>
    <div id="joinMsg"></div></form>`;
}
function renderEdit(m) {
  m.innerHTML = `
  <section class="panel">
    ${modeBanner()}${infoHTML()}${finalHTML()}
    ${S.me ? `<div class="who" id="whoLine"><span>你是 <b id="whoName"></b></span><button class="link" id="switchBtn" type="button">不是你？</button>
      <label class="check inline"><input type="checkbox" id="myReq" ${S.me.required ? 'checked' : ''}> 我是必到者</label><span class="save" id="saveStatus">${esc(S.saveText)}</span></div>` : joinHTML()}
    <div class="actions">
      <button class="btn sm" id="clearMine" type="button" ${S.me ? '' : 'disabled'}>全部清除</button>
    </div>
    <p class="note"><span class="sw on"></span><span>塗滿的格子代表你有空。可以框選整段時間，從已塗的格子開始拖就是擦除。</span></p>
  </section>
  <div id="gridHost"></div>${tzNote()}`;
  const wn = $('#whoName'); if (wn) wn.textContent = S.me.name;
  buildGrid($('#gridHost'), 'edit');
  bindFinal(m); bindJoin();
  const sw = $('#switchBtn'); if (sw) sw.addEventListener('click', () => { if (S.src !== 'demo' && S.me) endSessionQuietly(S.id, S.me.token); S.me = null; S.prefillName = ''; S.mine = new Uint8Array(S.G.N); S.undo = null; S.saveText = ''; if (S.src !== 'demo') store.del('jsj:me:' + S.id); renderEvent(); setTimeout(() => { const f = $('#nameInput'); if (f) f.focus(); }, 30); });
  const mr = $('#myReq'); if (mr) mr.addEventListener('change', () => { S.me.required = mr.checked; S.me.reqDirty = true; void saveMine(); toast(mr.checked ? '已標記你為必到者' : '已取消必到者'); });
  $('#clearMine').addEventListener('click', () => { const prev = S.mine.slice(); S.mine = new Uint8Array(S.G.N); paintCells(); commit(prev, '已清除你的所有劃記'); });
}
function joinError(msg, text) { const p = document.createElement('p'); p.className = 'err'; p.textContent = text; msg.replaceChildren(p); }
function bindJoin() {
  const f = $('#joinForm'); if (!f) return;
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#nameInput').value.trim().slice(0, 20), msg = $('#joinMsg'), wantReq = $('#reqInput').checked;
    if (!name) { joinError(msg, '請輸入暱稱。'); return; }
    if (S.src === 'demo') { finishJoin({ name, pid: null, token: null }, findByName(name), wantReq); return; }
    const pinEl = $('#joinPin'), pin = pinEl.value.trim();
    if (!/^\d{4}$/.test(pin)) { joinError(msg, '請輸入 4 位數字的個人密碼。'); pinEl.focus(); return; }
    const btn = $('#joinBtn'), id = S.id; btn.disabled = true;
    let r;
    try { r = await withTimeout(API.join(id, name, pin), 15000); }
    catch (err) {
      if (S.id !== id) return;
      btn.disabled = false;
      const c = errCode(err);
      joinError(msg, c === 'wrong_pin' ? '這個暱稱已經有人使用，密碼不正確。如果是你本人但忘記密碼，請主理人幫你重設；不是的話請換一個暱稱。' : (pinErr(err) || '連線失敗，請再試一次。'));
      pinEl.select(); return;
    }
    if (S.id !== id) return;
    const pid = String(r.pid || '');
    if (!S.people.has(pid)) S.people.set(pid, { name, avail: new Uint8Array(S.G.N), required: false });
    finishJoin({ name: S.people.get(pid).name, pid, token: r.token }, r.status === 'created' ? null : [pid, S.people.get(pid)], wantReq);
  });
}
function finishJoin(me, hit, wantReq) {
  S.undo = null; S.prefillName = '';
  const back = hit && sum(hit[1].avail) > 0;
  setMe({ ...me, name: hit ? hit[1].name : me.name, pid: hit ? hit[0] : me.pid, required: hit ? hit[1].required : false });
  S.mine = hit ? hit[1].avail.slice() : new Uint8Array(S.G.N);
  S.saveText = back ? '已載入你之前填的時間' : '';
  if (wantReq && !S.me.required) { S.me.required = true; S.me.reqDirty = true; void saveMine(); }
  renderEvent();
  toast(back ? `歡迎回來，${S.me.name}！可以直接修改` : '開始劃記吧！');
}
function setMe(me) { S.me = me; if (S.src !== 'demo') store.set('jsj:me:' + S.id, { name: me.name, pid: me.pid, token: me.token }); }

/* --- heat tab --- */
function renderHeat(m) {
  const all = peopleList(), filled = all.filter(p => sum(p.avail) > 0), pending = all.filter(p => sum(p.avail) === 0);
  m.innerHTML = `
  <section class="panel">
    ${modeBanner()}${infoHTML()}${finalHTML()}
    <div class="summary"><b>${filled.length}</b> 人已填寫${pending.length ? `，${pending.length} 人尚未劃記` : ''}</div>
    ${filled.length ? `<div class="legend"><span>0</span><span class="ramp"></span><span>${filled.length} 人有空</span><span>· 右上角圓點＝全員有空</span></div>` : ''}
    ${reqToggleHTML()}
    <div class="chips">${filled.map(p => nameChip(p)).join('')}${pending.map(p => `<span class="chip pending">${esc(p.name)}（未劃記）</span>`).join('')}</div>
    ${reqActive() ? `<p class="note"><span class="sw blocked"></span><span>灰色格子代表有必到者沒空。</span></p>` : ''}
    ${S.hl ? `<p class="note">框線是你選的推薦時段：${esc(slotLabel(S.hl.start, S.hl.k))} <button class="link" id="clearHl" type="button">取消框線</button></p>` : `<p class="note">點任一格，看看那個時段誰有空。</p>`}
  </section>
  ${filled.length ? '<div id="gridHost"></div>' + tzNote() : `<div class="empty">還沒有人劃記。到「我的時間」填好後，熱力圖就會出現。</div>`}`;
  if (filled.length) buildGrid($('#gridHost'), 'heat');
  bindFinal(m); bindReqToggle(m);
  const ch = $('#clearHl'); if (ch) ch.addEventListener('click', () => { S.hl = null; renderEvent(); });
}

/* --- best tab --- */
function renderBest(m) {
  const ev = S.event, filled = filledList(), maxMin = S.G.rows * ev.step;
  const opts = [...new Set([30, 60, 90, 120, 150, 180, 240, ev.duration])].filter(d => d % ev.step === 0 && d <= maxMin && d >= ev.step).sort((a, b) => a - b);
  const useReq = reqActive(), k = S.dur / ev.step, list = rankSlots(filled, k, 6, useReq), n = filled.length;
  const isFinal = c => S.final && S.final.start === c.start && S.final.k === k;
  m.innerHTML = `
  <section class="panel">
    ${modeBanner()}${infoHTML()}${finalHTML()}
    <span class="lbl">活動長度</span>
    ${reqToggleHTML()}
    <div class="durs">${opts.map(d => `<button type="button" class="dur" data-d="${d}" aria-pressed="${d === S.dur}">${durLabel(d)}</button>`).join('')}</div>
    <p class="note">依「全程都能到的人數」排序，同分時看部分出席的總時數，再依時間先後。${S.admin ? '你是主理人，可以直接把某個時段定案。' : '主理人登入後可以把時段定案。'}</p>
  </section>
  ${!n ? `<div class="empty">還沒有人劃記，暫時無法推薦。</div>`
    : !list.length ? (useReq ? `<div class="empty"><p>在 ${durLabel(S.dur)} 的長度下，沒有任何時段能讓所有必到者全程參加。</p><p><button class="btn sm" type="button" data-rm="all">改看全體</button></p></div>`
      : `<div class="empty">在 ${durLabel(S.dur)} 的長度下，沒有任何時段有人有空。試試縮短活動長度。</div>`)
    : `<ol class="best">${list.map((c, i) => {
      const allIn = c.full === n;
      return `<li class="slot">
          <span class="rk">${i + 1}</span>
          <span class="when">${slotHTML(c.start, k)}</span>
          <span class="score">${c.full}/${n}</span>
          <span class="detail">${allIn ? `<span class="pill good">全員到齊</span>` : `<span class="pill warn">${c.full} 人全程</span>`}
            ${isFinal(c) ? `<span class="pill good">已定案</span>` : ''}
            ${c.reqMissing.length ? `<span class="pill bad">缺必到者：${esc(c.reqMissing.join('、'))}</span>` : (requiredFilled().length ? `<span class="pill good">必到者都到</span>` : '')}
            ${c.partial.length ? `<span>部分時間：${esc(c.partial.join('、'))}</span>` : ''}
            ${c.absent.length ? `<span>不行：${esc(c.absent.join('、'))}</span>` : ''}</span>
          <span class="slot-act"><button type="button" class="btn sm" data-view="${c.start}">在熱力圖查看</button>
            ${S.admin && !isFinal(c) ? `<button type="button" class="btn sm primary" data-final="${c.start}">定案這個時段</button>` : ''}</span>
        </li>`;
    }).join('')}</ol>`}`;
  bindFinal(m);
  bindReqToggle(m);
  m.querySelectorAll('.dur').forEach(b => b.addEventListener('click', () => { S.dur = +b.dataset.d; renderEvent(); }));
  m.querySelectorAll('[data-final]').forEach(b => b.addEventListener('click', () => setFinal({ start: +b.dataset.final, k })));
  m.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    const start = +b.dataset.view; S.hl = { start, k }; S.tab = 'heat';
    S.page = Math.floor(slotDay(start) / Math.max(1, S.per)); renderEvent();
    const el = document.querySelector(`.c[data-i="${start}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
}

/* ================= grid ================= */
const CELL_H = { 15: 20, 30: 26, 60: 36 };
const RAIL_W = COARSE ? 36 : 0;
// 固定一頁 7 天，每頁都是同樣的星期幾到星期幾
const perPageFor = () => Math.min(7, S.event.dates.length);
function buildGrid(host, kind) {
  const ev = S.event, rows = S.G.rows;
  const per = perPageFor();
  if (per !== S.per) { const firstDay = S.page * S.per; S.per = per; S.page = Math.floor(firstDay / per); }
  const pages = Math.ceil(ev.dates.length / per); S.page = clamp(S.page, 0, pages - 1);
  const d0 = S.page * per, days = ev.dates.slice(d0, d0 + per), nd = days.length, cols = per; // 最後一頁不足 7 天時用空白欄補齊
  const cellH = CELL_H[ev.step];
  let axis = '', cells = '';
  for (let r = 0; r < rows; r++) {
    const min = ev.startMin + r * ev.step, onHour = min % 60 === 0;
    axis += `<div>${onHour ? `<span>${hm(min)}</span>` : ''}</div>`;
    for (let c = 0; c < nd; c++) { const i = (d0 + c) * rows + r; cells += `<div class="c${onHour ? ' hr' : ''}${r === 0 ? ' r0' : ''}" data-i="${i}"></div>`; }
    for (let c = nd; c < cols; c++) cells += `<div class="c pad${onHour ? ' hr' : ''}${r === 0 ? ' r0' : ''}" aria-hidden="true"></div>`;
  }
  const first = dayInfo(days[0]), last = dayInfo(days[nd - 1]);
  host.innerHTML = `
    ${pages > 1 ? `<div class="pager"><button class="pg" id="pgPrev" type="button" aria-label="前幾天" ${S.page === 0 ? 'disabled' : ''}>‹</button>
      <div class="pg-label"><span class="mono">${first.md}–${last.md}</span>　第 ${S.page + 1}/${pages} 頁 · 共 ${ev.dates.length} 天</div>
      <button class="pg" id="pgNext" type="button" aria-label="後幾天" ${S.page >= pages - 1 ? 'disabled' : ''}>›</button></div>` : ''}
    <div class="grid ${kind}${RAIL_W ? ' has-rail' : ''}">
      <div class="ghead"><div></div>${days.map(ds => { const di = dayInfo(ds); return `<div><span class="md">${di.md}</span><span class="wk ${di.we ? 'we' : ''}">週${di.wk}</span></div>`; }).join('')}${'<div class="pad-h"></div>'.repeat(cols - nd)}${RAIL_W ? '<div class="rail-h" aria-hidden="true">捲動</div>' : ''}</div>
      <div class="gbody"><div class="axis">${axis}</div><div class="cells" id="cells">${cells}</div>${RAIL_W ? '<div class="rail" aria-hidden="true"><div class="grip"><i></i><i></i><i></i></div></div>' : ''}</div>
    </div>`;
  const gridEl = $('.grid', host);
  gridEl.style.setProperty('--nd', String(cols)); gridEl.style.setProperty('--cell-h', cellH + 'px'); gridEl.style.setProperty('--rail-w', RAIL_W + 'px');
  const pp = $('#pgPrev', host), pn = $('#pgNext', host);
  if (pp) pp.addEventListener('click', () => { S.page--; renderEvent(); });
  if (pn) pn.addEventListener('click', () => { S.page++; renderEvent(); });
  const cellsEl = $('#cells', host);
  const els = [...cellsEl.children].filter(el => el.dataset.i != null); els.forEach(el => el._i = +el.dataset.i);
  S.grid = { kind, els, cellsEl, d0, nd, cols, rows, cellH };
  cellsEl.classList.toggle('paint', kind === 'edit' && (!COARSE || S.paintTouch));
  attachPointer(S.grid);
  paintCells();
}
function paintCells() {
  const g = S.grid; if (!g || !S.event) return;
  if (g.kind === 'edit') {
    for (const el of g.els) { const i = el._i; el.classList.toggle('on', !!S.mine[i]); }
    return;
  }
  const filled = filledList(), n = filled.length, count = new Uint16Array(S.G.N);
  filled.forEach(p => { for (let i = 0; i < S.G.N; i++) count[i] += p.avail[i]; });
  const hl = S.hl || S.final, reqs = reqActive() ? filled.filter(p => p.required) : [];
  for (const el of g.els) {
    const i = el._i, c = count[i], p = n ? c / n : 0;
    el.classList.toggle('blocked', reqs.length > 0 && reqs.some(q => !q.avail[i]));
    el.style.setProperty('--p', p.toFixed(3));
    el.textContent = c ? c : '';
    el.classList.toggle('dark', p > .55);
    el.classList.toggle('full', n > 0 && c === n);
    el.classList.toggle('sel', S.sel === i);
    const inHl = hl && i >= hl.start && i < hl.start + hl.k;
    el.classList.toggle('hl', !!inHl);
    el.classList.toggle('hl-t', !!inHl && i === hl.start);
    el.classList.toggle('hl-b', !!inHl && i === hl.start + hl.k - 1);
  }
}

/* Pointer handling: paint mode uses touch-action:none on the cells; scroll mode lets the page pan and treats a tap as a single toggle. */
function attachPointer(g) {
  const el = g.cellsEl;
  let drag = null, tap = null, raf = 0, scrollRaf = 0;
  const hit = (x, y) => { const r = el.getBoundingClientRect(); return { col: clamp(Math.floor((x - r.left) / (r.width / g.cols)), 0, g.nd - 1), row: clamp(Math.floor((y - r.top) / g.cellH), 0, g.rows - 1) }; };
  const idx = h => (g.d0 + h.col) * g.rows + h.row;
  const painting = e => g.kind === 'edit' && (e.pointerType !== 'touch' || S.paintTouch);

  function apply() {
    const next = drag.base.slice();
    if (S.brush === 'rect') {
      const c0 = Math.min(drag.anchor.col, drag.cur.col), c1 = Math.max(drag.anchor.col, drag.cur.col);
      const r0 = Math.min(drag.anchor.row, drag.cur.row), r1 = Math.max(drag.anchor.row, drag.cur.row);
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) next[idx({ col: c, row: r })] = drag.val;
    } else drag.visited.forEach(i => next[i] = drag.val);
    S.mine = next; paintCells();
  }
  function update() {
    if (!drag) return;
    const h = hit(drag.x, drag.y);
    if (S.brush === 'brush') {
      const a = drag.cur, steps = Math.max(Math.abs(h.col - a.col), Math.abs(h.row - a.row), 1);
      for (let s = 1; s <= steps; s++) drag.visited.add(idx({ col: Math.round(a.col + (h.col - a.col) * s / steps), row: Math.round(a.row + (h.row - a.row) * s / steps) }));
    }
    drag.cur = h; apply();
  }
  function autoScroll() {
    if (!drag) return;
    const topEdge = $('#top').getBoundingClientRect().bottom + 46, tb = $('#toolbar'), bottomEdge = tb.hidden ? innerHeight : tb.getBoundingClientRect().top;
    let dy = 0;
    if (drag.y < topEdge + 30) dy = -Math.min(16, Math.ceil((topEdge + 30 - drag.y) / 3));
    else if (drag.y > bottomEdge - 30) dy = Math.min(16, Math.ceil((drag.y - (bottomEdge - 30)) / 3));
    if (dy) { const before = scrollY; scrollBy(0, dy); if (scrollY !== before) update(); }
    scrollRaf = requestAnimationFrame(autoScroll);
  }
  function end(e) {
    if (tap && e.type === 'pointerup' && e.pointerId === tap.id) {
      const h = hit(e.clientX, e.clientY), i = idx(h);
      if (g.kind === 'heat') { S.sel = i; paintCells(); showDetail(i); }
      else if (S.me) { const prev = S.mine.slice(); S.mine = prev.slice(); S.mine[i] = S.mine[i] ? 0 : 1; paintCells(); commit(prev); }
      else nudgeJoin();
    }
    tap = null;
    if (drag && e.pointerId === drag.id) {
      cancelAnimationFrame(raf); cancelAnimationFrame(scrollRaf); raf = 0;
      const prev = drag.base; drag = null; S.dragging = false; commit(prev);
    }
  }
  const inPad = x => { const r = el.getBoundingClientRect(); return Math.floor((x - r.left) / (r.width / g.cols)) >= g.nd; };
  el.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    if (inPad(e.clientX)) return; // 最後一頁的空白欄，不能劃記
    if (!painting(e) || !S.me) { tap = { id: e.pointerId, x: e.clientX, y: e.clientY }; return; }
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    const h = hit(e.clientX, e.clientY), i = idx(h);
    drag = { id: e.pointerId, anchor: h, cur: h, val: S.mine[i] ? 0 : 1, base: S.mine.slice(), visited: new Set([i]), x: e.clientX, y: e.clientY };
    S.dragging = true; apply(); scrollRaf = requestAnimationFrame(autoScroll);
  });
  el.addEventListener('pointermove', e => {
    if (tap && e.pointerId === tap.id && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null;
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); });
  });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
  el.addEventListener('contextmenu', e => { if (g.kind === 'edit') e.preventDefault(); });
}
function nudgeJoin() { const f = $('#nameInput'); if (f) { f.focus(); f.scrollIntoView({ block: 'center', behavior: 'smooth' }); } toast('先輸入暱稱，才能開始劃記'); }

/* ================= saving ================= */
let saving = false, dirty = false, saveTimer = 0, pendingSave = false;
function commit(prev, message) {
  if (same(prev, S.mine)) return;
  S.undo = prev; renderToolbar();
  if (message) toast(message, { label: '復原', run: doUndo });
  pendingSave = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveMine, 250);
}
function doUndo() { if (!S.undo) return; const cur = S.mine; S.mine = S.undo; S.undo = cur; paintCells(); renderToolbar(); void saveMine(); }
function setSave(text) { S.saveText = text; const st = $('#saveStatus'); if (st) st.textContent = text; }
async function saveMine() {
  pendingSave = false;
  if (!S.me) return;
  $('#ctHeat').textContent = filledList().length || '';
  if (S.src === 'demo') { setSave('範例模式，不會儲存'); return; }
  dirty = true; if (saving) return; saving = true; setSave('儲存中…');
  const id = S.id;
  while (dirty && S.id === id) {
    dirty = false;
    const snapshot = S.mine.slice();
    const me = S.me;
    try {
      const sendReq = me.reqDirty ? me.required : null;
      await withTimeout(API.save(id, me.token, snapshot, sendReq), 15000);
      if (sendReq != null && me.required === sendReq) me.reqDirty = false;
      if (S.id === id && S.me === me && me.pid) S.people.set(me.pid, { name: me.name, avail: snapshot, required: !!me.required });
    }
    catch (err) {
      saving = false;
      const c = errCode(err);
      if (c === 'forbidden' && S.id === id && S.me === me) { sessionLost(); return; }
      setSave(c === 'rate_limited' ? '儲存太頻繁了，稍後會再試一次' : '儲存失敗，下次劃記時會再試一次');
      return;
    }
  }
  saving = false; if (S.id === id) setSave('已同步');
}
// 登入失效（主理人重設了你的密碼）：請使用者重新輸入暱稱與密碼
function sessionLost() {
  const name = S.me ? S.me.name : '';
  S.me = null; S.mine = new Uint8Array(S.G.N); S.undo = null; S.saveText = ''; S.prefillName = name;
  store.del('jsj:me:' + S.id);
  closeSheet(); renderEvent(); toast('登入已失效，請重新輸入暱稱和個人密碼');
}
addEventListener('beforeunload', e => { if (pendingSave || saving) { e.preventDefault(); e.returnValue = ''; } });

/* ================= toolbar, sheet, toast ================= */
function setTbH() { const tb = $('#toolbar'); document.documentElement.style.setProperty('--tb-h', tb.hidden ? '0px' : tb.offsetHeight + 'px'); }
function renderToolbar() {
  const tb = $('#toolbar');
  if (!S.event || S.tab !== 'edit') { tb.hidden = true; setTbH(); return; }
  tb.hidden = false;
  tb.innerHTML = `<div class="tb-in">
    <div class="seg" role="group" aria-label="塗法"><button type="button" data-b="rect" aria-pressed="${S.brush === 'rect'}">框選</button><button type="button" data-b="brush" aria-pressed="${S.brush === 'brush'}">筆刷</button></div>
    <span class="tb-spacer"></span>
    <button type="button" class="btn sm" id="undoBtn" ${S.undo ? '' : 'disabled'}>復原</button>
  </div>
  <div class="tb-hint">${!S.me ? '輸入暱稱後就能開始劃記。'
    : COARSE ? '在格子上拖曳就能塗抹或擦除；要上下捲動，請在右側灰色捲動條（或左側時間軸）上滑動。'
    : (S.brush === 'rect' ? '框選：從起點拖到終點，選出整塊矩形。從已選的格子開始拖就是擦除。' : '筆刷：滑過的格子都會被塗上。從已選的格子開始拖就是擦除。')}</div>`;
  tb.querySelectorAll('[data-b]').forEach(b => b.addEventListener('click', () => { S.brush = b.dataset.b; renderToolbar(); }));
  $('#undoBtn').addEventListener('click', doUndo);
  setTbH();
}
function closeSheet() { const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; if (S.sel != null) { S.sel = null; if (S.grid && S.grid.kind === 'heat') paintCells(); } }
function openSheet(html) { const s = $('#sheet'); s.innerHTML = `<div class="sheet-in" role="dialog" aria-modal="false">${html}</div>`; s.hidden = false; const x = $('.x', s); if (x) x.addEventListener('click', closeSheet); return s; }
function showDetail(i) {
  const all = filledList(), yes = all.filter(p => p.avail[i]), no = all.filter(p => !p.avail[i]);
  openSheet(`<div class="sh-h"><h3>${esc(slotLabel(i))}</h3><button class="x" type="button" aria-label="關閉">×</button></div>
    <div><span class="lbl">有空 ${yes.length}/${all.length}</span><div class="chips">${yes.map(p => nameChip(p)).join('') || '<span class="note">沒有人</span>'}</div></div>
    ${no.length ? `<div><span class="lbl">沒空</span><div class="chips">${no.map(p => nameChip(p, 'no')).join('')}</div></div>` : ''}`);
}
function copyText(text, okMsg, boxSel) {
  const fallback = () => { const b = boxSel && $(boxSel); if (b) { const r = document.createRange(); r.selectNodeContents(b); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } toast('無法自動複製，已幫你選取，請手動複製'); };
  const cb = navigator.clipboard;
  if (!cb || typeof cb.writeText !== 'function') { fallback(); return; }
  cb.writeText(text).then(() => toast(okMsg), fallback);
}
function openShare(fresh) {
  if (!S.event) return;
  const url = eventUrl(S.id), invite = `來填「${S.event.title}」你有空的時間！\n${url}`;
  const s = openSheet(`<div class="sh-h"><h3>${fresh ? '活動建立好了，把連結傳給大家' : '邀請大家來填'}</h3><button class="x" type="button" aria-label="關閉">×</button></div>
    <div class="linkbox" id="shareLink">${esc(url)}</div>
    <div class="actions">
      ${navigator.share ? `<button class="btn primary" type="button" id="nativeShare">分享連結</button>` : ''}
      <button class="btn ${navigator.share ? '' : 'primary'}" type="button" id="copyLink">複製連結</button>
      <button class="btn" type="button" id="copyMsg">複製邀請訊息</button>
    </div>
    ${fresh && S.admin && freshPin ? `<p class="note">你的主理人密碼是 <b class="mono">${esc(freshPin)}</b>，請記下來（之後不會再顯示）。這台裝置已經自動登入；換手機時，在活動頁按「主理人」輸入密碼就能管理。</p>` : ''}`);
  freshPin = '';
  const ns = $('#nativeShare', s);
  if (ns) ns.addEventListener('click', () => navigator.share({ title: S.event.title, text: `來填「${S.event.title}」你有空的時間！`, url }).catch(() => {}));
  $('#copyLink', s).addEventListener('click', () => copyText(url, '已複製連結', '#shareLink'));
  $('#copyMsg', s).addEventListener('click', () => copyText(invite, '已複製邀請訊息', '#shareLink'));
}
$('#shareBtn').addEventListener('click', () => openShare(false));
$('#adminBtn').addEventListener('click', openAdmin);
let toastTimer = 0;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="link" type="button" id="toastAct">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) $('#toastAct').addEventListener('click', () => { action.run(); t.hidden = true; });
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, action ? 5000 : 2600);
}

/* ================= layout plumbing ================= */
new ResizeObserver(() => document.documentElement.style.setProperty('--hdr-h', $('#top').offsetHeight + 'px')).observe($('#top'));
let rzTimer = 0;
addEventListener('resize', () => {
  clearTimeout(rzTimer); rzTimer = setTimeout(() => {
    setTbH();
    if (!S.event || S.dragging || !S.grid) return;
    const host = $('#gridHost'); if (!host) return;
    if (perPageFor() !== S.per) renderEvent();
  }, 150);
});
addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
// 防點擊劫持：GitHub Pages 無法設定 frame-ancestors 標頭，被嵌進別的網站時就不啟動
if (window.top === window.self) void route();
else { $('#main').textContent = '為了安全，揪時間不能嵌在其他網站裡使用，請直接開啟網址。'; }
