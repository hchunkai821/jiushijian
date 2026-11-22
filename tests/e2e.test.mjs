// 瀏覽器端對端測試：用真的瀏覽器操作網站，連到測試用資料庫；同時收集 app.js 的覆蓋率
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startSite, writeLcov, rpc, freshIp } from './helpers.mjs';

let site, browser;
const coverage = [];
const problems = [];
const pages = [];

before(async () => {
  site = await startSite();
  browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
});

after(async () => {
  for (const p of pages) if (!p.isClosed()) coverage.push(...await p.coverage.stopJSCoverage());
  await browser.close();
  await site.close();
  const pct = await writeLcov(coverage);
  console.log(`app.js 行覆蓋率：${pct}%`);
});

// 每個 page 都收集覆蓋率、記錄錯誤與 CSP 違規
async function open(path, { mobile = false, clipboard = true, storage = null, label = path } = {}) {
  const device = mobile ? { viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true } : { viewport: { width: 1100, height: 900 } };
  const ctx = await browser.newContext(device);
  // 每個瀏覽器模擬不同裝置的 IP（只加在打資料庫的請求上，不影響 CDN）
  const ip = freshIp();
  await ctx.route('**/rest/v1/**', r => r.continue({ headers: { ...r.request().headers(), 'x-test-client-ip': ip } }));
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.origin });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push(`[${label}] ${e.message}`));
  page.on('console', m => {
    // 測試環境沒有 Realtime 伺服器，websocket 連線失敗是預期的
    if (m.type() === 'error' && !/websocket|realtime|ws:\/\/|Failed to load resource/i.test(m.text())) problems.push(`[${label}] ${m.text()}`);
  });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => {
    if (!e.blockedURI.startsWith('ws')) console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
  }));
  if (storage) await page.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); }, storage);
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  pages.push(page);
  await page.goto(site.origin + '/jiushijian/' + path);
  return page;
}
async function close(page) {
  coverage.push(...await page.coverage.stopJSCoverage());
  await page.context().close();
}
const toastText = page => page.locator('#toast').innerText();
const waitToast = (page, text) => page.locator('#toast', { hasText: text }).waitFor();
const resync = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
async function drag(page, from, to) {
  const a = await page.locator(`.cells .c[data-i="${from}"]`).boundingBox();
  const b = await page.locator(`.cells .c[data-i="${to}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.waitForTimeout(50);
  await page.mouse.up();
}
const synced = page => page.waitForFunction(() => document.querySelector('#saveStatus')?.textContent === '已同步', null, { timeout: 10000 });
const cellIndex = (page, n) => page.locator('.cells .c:not(.pad)').nth(n).getAttribute('data-i');

let eid = '';

test('首頁：表單驗證與建立活動', async () => {
  const page = await open('', { label: '主理人' });
  assert.ok(await page.locator('.privacy').isVisible(), '要有隱私說明');
  assert.equal(await page.locator('.mini i').first().evaluate(el => el.style.getPropertyValue('--p')), '0.2');
  const msg = page.locator('#createMsg');

  await page.click('#createBtn');
  assert.equal(await msg.innerText(), '請輸入活動名稱。');
  await page.fill('#fTitle', '端對端測試');

  const start = await page.inputValue('#fStart');
  await page.fill('#fEnd', '2099-12-31');
  assert.match(await page.locator('#rangeMsg').innerText(), /最多一個月/);
  await page.click('#createBtn');
  assert.match(await msg.innerText(), /最多一個月/);
  await page.fill('#fEnd', '');
  await page.click('#createBtn');
  assert.equal(await msg.innerText(), '請選擇開始和結束日期。');

  // 10 天，才會出現分頁
  const end = await page.evaluate(s => addDays(s, 9), start);
  await page.fill('#fEnd', end);
  await page.selectOption('#fFrom', '1200');
  await page.selectOption('#fTo', '600');
  await page.click('#createBtn');
  assert.equal(await msg.innerText(), '每天的結束時間要晚於開始時間。');
  await page.selectOption('#fFrom', '540');
  await page.selectOption('#fTo', '660');
  await page.selectOption('#fDur', '180');
  await page.click('#createBtn');
  assert.equal(await msg.innerText(), '活動長度比每天的時間範圍還長。');
  await page.selectOption('#fDur', '60');
  await page.fill('#fPin', '12');
  await page.click('#createBtn');
  assert.equal(await msg.innerText(), '主理人密碼請輸入 4 位數字。');

  await page.fill('#fLocName', '學校餐廳');
  await page.fill('#fLocAddr', '<img src=x onerror=alert(1)>');
  await page.fill('#fPin', '4321');
  await page.click('#createBtn');
  await page.waitForURL(/\?e=/);
  eid = new URL(page.url()).searchParams.get('e');
  assert.match(eid, /^[a-z0-9]{12}$/);

  await page.waitForSelector('#shareLink');
  assert.match(await page.locator('.sheet').innerText(), /4321/, '建立時顯示一次主理人密碼');
  await page.click('#copyLink');
  await waitToast(page, '已複製連結');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${site.origin}/jiushijian/?e=${eid}`);
  await page.click('#copyMsg');
  await waitToast(page, '已複製邀請訊息');
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#sheet').isHidden());

  assert.match(await page.locator('.addr').innerText(), /<img/, '地址以純文字顯示（XSS 防護）');
  assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), 'noindex, nofollow');
  const ls = await page.evaluate(() => JSON.stringify(localStorage));
  assert.doesNotMatch(ls, /4321/, '瀏覽器不保存主理人密碼');
  assert.equal(await page.locator('#adminBtn').innerText(), '主理人 ✓');

  // 分享視窗再開一次，不會再顯示密碼
  await page.click('#shareBtn');
  assert.doesNotMatch(await page.locator('.sheet').innerText(), /4321/);
  await page.click('.sheet .x');
  await close(page);
});

test('參與者：加入、劃記、筆刷、復原、清除、必到者、分頁', async () => {
  const page = await open(`?e=${eid}`, { label: '小明' });
  await page.waitForSelector('#joinForm');

  // 還沒加入就點格子：提醒先輸入暱稱
  await page.locator('.cells .c').first().click();
  await waitToast(page, '先輸入暱稱');

  await page.click('#joinBtn');
  assert.equal(await page.locator('#joinMsg').innerText(), '請輸入暱稱。');
  await page.fill('#nameInput', '小明');
  await page.click('#joinBtn');
  assert.match(await page.locator('#joinMsg').innerText(), /4 位數字/);
  await page.fill('#joinPin', '1111');
  await page.check('#reqInput');
  await page.click('#joinBtn');
  await page.waitForSelector('#whoName');
  assert.equal(await page.locator('#whoName').innerText(), '小明');
  await synced(page);

  const c0 = await cellIndex(page, 0), c1 = await cellIndex(page, 9);
  await drag(page, c0, c1);
  await synced(page);
  const afterRect = await page.locator('.cells .c.on').count();
  assert.ok(afterRect >= 4, `框選應該塗多格，實際 ${afterRect}`);

  // 從已塗的格子開始拖＝擦除
  await drag(page, c0, c0);
  await synced(page);
  assert.equal(await page.locator('.cells .c.on').count(), afterRect - 1);

  await page.click('[data-b="brush"]');
  assert.match(await page.locator('.tb-hint').innerText(), /筆刷/);
  const b0 = await cellIndex(page, 20), b1 = await cellIndex(page, 26);
  await drag(page, b0, b1);
  await synced(page);
  const afterBrush = await page.locator('.cells .c.on').count();
  assert.ok(afterBrush > afterRect - 1);

  await page.click('#undoBtn');
  await synced(page);
  assert.equal(await page.locator('.cells .c.on').count(), afterRect - 1);
  await page.click('[data-b="rect"]');

  await page.click('#clearMine');
  await waitToast(page, '已清除');
  assert.equal(await page.locator('.cells .c.on').count(), 0);
  await page.click('#toastAct');
  assert.equal(await page.locator('.cells .c.on').count(), afterRect - 1);
  await synced(page);

  await page.uncheck('#myReq');
  await waitToast(page, '已取消必到者');
  await page.check('#myReq');
  await waitToast(page, '已標記你為必到者');
  await synced(page);

  // 10 天 → 兩頁
  assert.match(await page.locator('.pg-label').innerText(), /第 1\/2 頁/);
  await page.click('#pgNext');
  assert.match(await page.locator('.pg-label').innerText(), /第 2\/2 頁/);
  assert.ok(await page.locator('.cells .c.pad').count() > 0, '最後一頁不足 7 天要補空白欄');
  const pad = await page.locator('.cells .c.pad').first().boundingBox();
  await page.mouse.click(pad.x + 3, pad.y + 3);
  await page.click('#pgPrev');

  // 視窗大小改變
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(300);
  await close(page);
});

test('換裝置：密碼錯誤被擋，正確密碼回到自己的填寫；不是你？可以切換', async () => {
  const page = await open(`?e=${eid}`, { label: '小明-手機' });
  await page.fill('#nameInput', '小明');
  await page.fill('#joinPin', '2222');
  await page.click('#joinBtn');
  await page.locator('#joinMsg .err').waitFor();
  assert.match(await page.locator('#joinMsg').innerText(), /密碼不正確/);
  await page.fill('#joinPin', '1111');
  await page.click('#joinBtn');
  await page.waitForSelector('#whoName');
  await waitToast(page, '歡迎回來');
  assert.ok(await page.locator('.cells .c.on').count() > 0);

  await page.click('#switchBtn');
  await page.waitForSelector('#joinForm');
  await page.fill('#nameInput', '阿哲');
  await page.fill('#joinPin', '2020');
  await page.click('#joinBtn');
  await page.waitForSelector('#whoName');
  const t = await cellIndex(page, 3);
  await page.locator(`.cells .c[data-i="${t}"]`).click();
  await synced(page);
  await close(page);
});

test('熱力圖與最佳時段', async () => {
  const page = await open(`?e=${eid}`, { label: '訪客' });
  await page.click('[data-tab="heat"]');
  await page.waitForSelector('.grid.heat');
  assert.equal(await page.locator('#ctHeat').innerText(), '2');
  assert.match(await page.locator('.summary').innerText(), /2/);
  await page.locator('.cells .c.full, .cells .c').first().click();
  await page.locator('.sheet').waitFor();
  assert.match(await page.locator('.sheet').innerText(), /有空/);
  await page.click('.sheet .x');

  assert.ok(await page.locator('.reqbar').isVisible(), '有必到者時顯示切換');
  await page.click('[data-rm="all"]');
  await page.click('[data-rm="req"]');

  await page.click('[data-tab="best"]');
  await page.waitForSelector('.durs');
  await page.locator('.dur').first().click();
  await page.locator('.dur').nth(1).click();
  const view = page.locator('[data-view]').first();
  if (await view.count()) {
    await view.click();
    await page.waitForSelector('.grid.heat');
    assert.ok(await page.locator('.cells .c.hl').count() > 0, '推薦時段要框起來');
    await page.click('#clearHl');
  }
  await close(page);
});

test('主理人：錯誤密碼、登入、修改資訊、必到者、定案、公告、重設密碼、移除成員', async () => {
  const page = await open(`?e=${eid}`, { label: '主理人-新裝置' });
  await page.click('#adminBtn');
  await page.click('#pinBtn');
  assert.equal(await page.locator('#pinMsg').innerText(), '請輸入 4 位數字。');
  await page.fill('#pinInput', '0000');
  await page.click('#pinBtn');
  await page.locator('#pinMsg', { hasText: '密碼不正確' }).waitFor();
  await page.fill('#pinInput', '4321');
  await page.click('#pinBtn');
  await page.waitForSelector('#infoForm');
  await waitToast(page, '已用主理人身份登入');

  await page.fill('#eTitle', '');
  await page.click('#infoBtn');
  await waitToast(page, '活動名稱不能空白');
  await page.fill('#eTitle', '改過的名稱');
  await page.fill('#eLocAddr', '台北市大安區');
  await page.click('#infoBtn');
  await waitToast(page, '已更新活動資訊');
  assert.equal(await page.locator('#evTitle').innerText(), '改過的名稱');
  assert.equal(await page.locator('.place a').getAttribute('rel'), 'noopener noreferrer');

  await page.click('#adminBtn');
  const zhe = page.locator('.members li', { hasText: '阿哲' });
  await zhe.locator('[data-req]').check();
  await waitToast(page, '設為必到者');
  await page.click('#adminBtn');
  await page.locator('.members li', { hasText: '阿哲' }).locator('[data-req]').uncheck();
  await waitToast(page, '取消');
  await page.click('.sheet .x');

  // 定案
  await page.click('[data-tab="best"]');
  await page.locator('[data-final]').first().click();
  await page.locator('#annText').waitFor();
  assert.match(await page.locator('#annText').innerText(), /時間定好了/);
  await page.click('#copyAnnBtn');
  await waitToast(page, '已複製');
  await page.click('.sheet .x');
  assert.ok(await page.locator('.final').first().isVisible());
  await page.click('#copyAnn');
  await page.locator('#annText').waitFor();
  await page.click('.sheet .x');
  await page.click('#unfinal');
  await waitToast(page, '已取消定案');

  // 重設阿哲的密碼
  await page.click('#adminBtn');
  const reset = page.locator('.members li', { hasText: '阿哲' }).locator('[data-reset]');
  await reset.click();
  assert.equal(await reset.innerText(), '確定重設？');
  await reset.click();
  await waitToast(page, '已重設');
  await page.click('.sheet .x');
  await close(page);
});

test('密碼被重設：舊裝置要重新登入；被移除：通知並回到加入畫面', async () => {
  const zhe = await open(`?e=${eid}`, { label: '阿哲-舊裝置' });
  await zhe.fill('#nameInput', '阿哲');
  await zhe.fill('#joinPin', '3030');
  await zhe.click('#joinBtn');
  await zhe.waitForSelector('#whoName');
  await waitToast(zhe, '歡迎回來');

  // 主理人在另一台裝置移除阿哲
  const admin = await open(`?e=${eid}`, { label: '主理人-移除' });
  await admin.click('#adminBtn');
  await admin.fill('#pinInput', '4321');
  await admin.click('#pinBtn');
  await admin.waitForSelector('#infoForm');
  const kick = admin.locator('.members li', { hasText: '阿哲' }).locator('[data-kick]');
  await kick.click();
  await kick.click();
  await waitToast(admin, '已移除 阿哲');

  await resync(zhe);
  await waitToast(zhe, '主理人已將你移出');
  assert.ok(await zhe.locator('#joinForm').isVisible());

  // 小明的密碼被重設 → 小明的裝置下次儲存時失效
  const ming = await open(`?e=${eid}`, { label: '小明-第三台' });
  await ming.fill('#nameInput', '小明');
  await ming.fill('#joinPin', '1111');
  await ming.click('#joinBtn');
  await ming.waitForSelector('#whoName');
  await admin.click('.sheet .x');
  await admin.click('#adminBtn');
  const r = admin.locator('.members li', { hasText: '小明' }).locator('[data-reset]');
  await r.click();
  await r.click();
  await waitToast(admin, '已重設');
  const c = await cellIndex(ming, 12);
  await ming.locator(`.cells .c[data-i="${c}"]`).click();
  await waitToast(ming, '登入已失效');
  assert.equal(await ming.inputValue('#nameInput'), '小明', '重新登入時預填暱稱');
  await close(ming);
  await close(zhe);

  // 登出
  await admin.click('#logoutBtn');
  await waitToast(admin, '已登出主理人');
  assert.equal(await admin.locator('#adminBtn').innerText(), '主理人');
  await close(admin);
});

test('主理人密碼錯太多次：顯示鎖定到幾點', async () => {
  const e = (await rpc('create_event', { p_title: '鎖定', p_tz: 'Asia/Taipei', p_dates: ['2026-12-01'], p_start: 540, p_end: 600, p_step: 30, p_duration: 30, p_pin: '1234' }, { ip: freshIp() })).body;
  const page = await open(`?e=${e.id}`, { label: '鎖定' });
  await page.click('#adminBtn');
  for (let i = 0; i < 5; i++) {
    await page.fill('#pinInput', '0000');
    await page.click('#pinBtn');
    await page.locator('#pinBtn:not([disabled])').waitFor();
  }
  assert.match(await page.locator('#pinMsg').innerText(), /鎖定到 \d+\/\d+ \d\d:\d\d/);
  await close(page);
});

test('從舊版升級：瀏覽器裡的主理人密碼換成 token；舊暱稱預填', async () => {
  const e = (await rpc('create_event', { p_title: '舊版升級', p_tz: 'Asia/Taipei', p_dates: ['2026-12-01'], p_start: 540, p_end: 600, p_step: 30, p_duration: 30, p_pin: '5678' }, { ip: freshIp() })).body;
  const page = await open(`?e=${e.id}`, { label: '舊版', storage: { [`jsj:pin:${e.id}`]: '5678', [`jsj:me:${e.id}`]: { name: '舊暱稱' }, 'jsj:recent': [{ id: e.id, title: '舊版升級' }] } });
  await page.locator('#adminBtn', { hasText: '主理人 ✓' }).waitFor();
  const ls = await page.evaluate(() => ({ ...localStorage }));
  assert.equal(ls[`jsj:pin:${e.id}`], undefined, '舊密碼要刪掉');
  assert.match(JSON.parse(ls[`jsj:admin:${e.id}`]), /^[0-9a-f]{64}$/);
  assert.equal(await page.inputValue('#nameInput'), '舊暱稱');

  // 首頁的最近活動：移除與復原
  await page.click('.brand');
  await page.locator('.recent').waitFor();
  assert.match(await page.locator('.recent').innerText(), /主理人/);
  await page.locator('[data-rm-recent]').first().click();
  await waitToast(page, '已從列表移除');
  await page.click('#toastAct');
  await page.locator('.recent').waitFor();

  // 主理人刪除活動
  await page.locator('.recent a').first().click();
  await page.locator('#adminBtn', { hasText: '主理人 ✓' }).waitFor();
  await page.click('#adminBtn');
  await page.click('details summary');
  await page.click('#delBtn');
  await page.click('#delBtn');
  await waitToast(page, '活動已刪除');
  assert.ok(await page.locator('#createForm').isVisible());
  await close(page);
});

test('活動被刪除後，其他人的頁面會顯示已刪除', async () => {
  const e = (await rpc('create_event', { p_title: '會被刪', p_tz: 'Asia/Taipei', p_dates: ['2026-12-01'], p_start: 540, p_end: 600, p_step: 30, p_duration: 30, p_pin: '1234' }, { ip: freshIp() })).body;
  const page = await open(`?e=${e.id}`, { label: '旁觀者' });
  await page.waitForSelector('#joinForm');
  await rpc('delete_event', { p_event: e.id, p_token: e.token });
  await resync(page);
  await page.locator('#main', { hasText: '已經被主理人刪除' }).waitFor();
  assert.ok(await page.locator('#tabs').isHidden(), '活動頁的分頁要收起來');
  const ls = await page.evaluate(id => JSON.stringify(localStorage).includes(id), e.id);
  assert.equal(ls, false, '瀏覽器裡這個活動的資料要清掉');
  await close(page);
});

test('找不到活動、連線失敗、主理人登入失效', async () => {
  const page = await open('?e=zzzzzzzzzz', { label: '找不到' });
  await page.locator('#main', { hasText: '找不到這個活動' }).waitFor();
  assert.ok(await page.locator('#tabs').isHidden());

  await page.route('**/rest/v1/rpc/get_event', r => r.abort());
  await page.goto(`${site.origin}/jiushijian/?e=yyyyyyyyyy`);
  await page.locator('#main', { hasText: '連線失敗' }).waitFor();
  await page.unroute('**/rest/v1/rpc/get_event');

  // 瀏覽器裡的主理人 token 已失效（例如在別台裝置登出）
  const e = (await rpc('create_event', { p_title: '失效', p_tz: 'Asia/Taipei', p_dates: ['2026-12-01'], p_start: 540, p_end: 600, p_step: 30, p_duration: 30, p_pin: '1234' }, { ip: freshIp() })).body;
  await page.evaluate(([id]) => localStorage.setItem('jsj:admin:' + id, JSON.stringify('f'.repeat(64))), [e.id]);
  await page.goto(`${site.origin}/jiushijian/?e=${e.id}`);
  await page.locator('#adminBtn', { hasText: /^主理人$/ }).waitFor();
  assert.equal(await page.evaluate(id => localStorage.getItem('jsj:admin:' + id), e.id), null, '失效的 token 要刪掉');
  await close(page);
});

test('範例模式：不需要密碼，不會儲存', async () => {
  const page = await open('?demo', { label: '範例', clipboard: false });
  assert.ok(await page.locator('.banner').isVisible());
  assert.equal(await page.locator('#joinPin').count(), 0);
  await page.fill('#nameInput', '小安');
  await page.click('#joinBtn');
  await page.waitForSelector('#whoName');
  await waitToast(page, '歡迎回來');
  const c = await cellIndex(page, 5);
  await page.locator(`.cells .c[data-i="${c}"]`).click();
  await page.locator('#saveStatus', { hasText: '範例模式' }).waitFor();
  await page.click('[data-tab="best"]');
  assert.ok(await page.locator('.best .slot').count() > 0);
  await page.click('[data-tab="heat"]');
  await page.click('[data-tab="edit"]');
  await page.click('#switchBtn');
  await page.fill('#nameInput', '新朋友');
  await page.click('#joinBtn');
  await waitToast(page, '開始劃記吧');
  await close(page);
});

test('手機：觸控劃記與右側捲動條', async () => {
  const page = await open(`?e=${eid}`, { mobile: true, label: '手機' });
  assert.ok(await page.locator('.rail').count() === 1, '手機要有右側捲動條');
  await page.fill('#nameInput', '手機用戶');
  await page.fill('#joinPin', '7777');
  await page.click('#joinBtn');
  await page.waitForSelector('#whoName');
  const box = await page.locator('.cells .c:not(.pad)').nth(2).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await synced(page);
  assert.ok(await page.locator('.cells .c.on').count() >= 1);
  assert.match(await page.locator('.tb-hint').innerText(), /捲動條/);
  await close(page);
});

test('剪貼簿不能用時，改成幫使用者選取文字', async () => {
  const page = await open(`?e=${eid}`, { clipboard: false, label: '無剪貼簿' });
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
  await page.click('#shareBtn');
  await page.click('#copyLink');
  await waitToast(page, '無法自動複製');
  assert.equal(await page.evaluate(() => String(getSelection())), `${site.origin}/jiushijian/?e=${eid}`, '要幫使用者選取連結');
  await close(page);
});

test('資料庫還沒設定時，只能試玩範例', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push(`[未設定] ${e.message}`));
  await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.JIU_CONFIG = { SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co', SUPABASE_ANON_KEY: 'YOUR_KEY' };" }));
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto(`${site.origin}/jiushijian/`);
  assert.ok(await page.locator('.setup').isVisible());
  assert.ok(await page.locator('#createBtn').isDisabled());
  await page.goto(`${site.origin}/jiushijian/?e=abcdefgh`);
  await page.locator('#main', { hasText: '還沒設定資料庫' }).waitFor();
  coverage.push(...await page.coverage.stopJSCoverage());
  await ctx.close();
});

test('被嵌入其他網站的 iframe 時不啟動（防點擊劫持）', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${site.origin}/not-the-site`);
  await page.setContent(`<iframe src="${site.origin}/jiushijian/"></iframe>`);
  const text = await page.frameLocator('iframe').locator('#main').innerText();
  assert.match(text, /不能嵌在其他網站/);
  await ctx.close();
});

test('整個過程沒有 JavaScript 錯誤或 CSP 違規', () => {
  assert.deepEqual(problems, []);
});
