// 測試共用工具：讀取測試環境設定、產生 anon JWT、呼叫 PostgREST、靜態網站伺服器、覆蓋率輸出
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const file = path.join(ROOT, 'tests', '.test-env');
  if (!fs.existsSync(file)) throw new Error('找不到測試環境，請先執行 npm run test:setup');
  return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(l => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
}
export const ENV = loadEnv();

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(payload) {
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const sig = crypto.createHmac('sha256', ENV.JIU_TEST_JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export const ANON_JWT = signJwt({ role: 'anon', exp: 4102444800 });

// 模擬不同來源 IP（測試環境沒有 Cloudflare，所以可以自己帶 cf-connecting-ip）
let ipCounter = 0;
export const freshIp = () => `10.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}.${(process.pid % 200) + 1}`;

export async function rest(pathname, { method = 'GET', body, ip = '10.250.0.1', headers = {} } = {}) {
  const res = await fetch(ENV.JIU_TEST_REST + pathname, {
    method,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ANON_JWT}`, 'cf-connecting-ip': ip, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
export const rpc = (name, args, opts = {}) => rest(`/rpc/${name}`, { method: 'POST', body: args, ...opts });

export function sql(query) {
  return execFileSync('docker', ['exec', '-i', ENV.JIU_TEST_PG_CONTAINER, 'psql', '-U', 'postgres', '-h', 'localhost', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8' }).trim();
}

// 靜態網站 + /rest/v1 代理到測試用 PostgREST；網站放在 /jiushijian/ 底下，和 GitHub Pages 一樣
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.xml': 'application/xml' };
const SITE_FILES = new Set(['/index.html', '/app.js', '/config.js', '/styles.css', '/favicon.svg', '/sitemap.xml']);
export async function startSite() {
  const restUrl = new URL(ENV.JIU_TEST_REST);
  let origin = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, origin);
    if (u.pathname.startsWith('/rest/v1/')) {
      const proxied = http.request({
        host: restUrl.hostname, port: restUrl.port, method: req.method,
        path: u.pathname.slice('/rest/v1'.length) + u.search,
        // 測試瀏覽器用 x-test-client-ip 模擬不同裝置的 IP（正式環境由 Cloudflare 設定 cf-connecting-ip）
        headers: { ...req.headers, host: restUrl.host, 'cf-connecting-ip': req.headers['x-test-client-ip'] || '10.254.0.1' }
      }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      proxied.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(proxied);
      return;
    }
    let file = u.pathname.replace(/^\/jiushijian(?=\/|$)/, '');
    if (file === '/' || file === '') file = '/index.html';
    if (!SITE_FILES.has(file)) { res.writeHead(404); res.end(); return; }
    let data = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (file === '/index.html') {
      // 正式環境連到 Supabase；測試時改連本機代理，其餘 CSP 規則維持不變
      data = data.replace('https://xpnzyefimdywjihxvcda.supabase.co wss://xpnzyefimdywjihxvcda.supabase.co', origin);
    }
    if (file === '/config.js') data = `window.JIU_CONFIG = { SUPABASE_URL: '${origin}', SUPABASE_ANON_KEY: '${ANON_JWT}' };`;
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(r => server.close(r)) };
}

// 把 Chromium 的 V8 覆蓋率轉成 lcov，給 SonarQube 讀
export async function writeLcov(entries) {
  const { default: v8toIstanbul } = await import('v8-to-istanbul');
  const libCoverage = await import('istanbul-lib-coverage');
  const libReport = await import('istanbul-lib-report');
  const reports = await import('istanbul-reports');
  const map = libCoverage.default.createCoverageMap({});
  const file = path.join(ROOT, 'app.js');
  const source = fs.readFileSync(file, 'utf8');
  for (const entry of entries) {
    if (!new URL(entry.url).pathname.endsWith('/app.js')) continue;
    const conv = v8toIstanbul(file, 0, { source });
    await conv.load();
    conv.applyCoverage(entry.functions);
    map.merge(conv.toIstanbul());
  }
  const dir = path.join(ROOT, 'coverage');
  const context = libReport.default.createContext({ dir, coverageMap: map });
  reports.default.create('lcov').execute(context);
  reports.default.create('text-summary').execute(context);
  return map.getCoverageSummary().lines.pct;
}
