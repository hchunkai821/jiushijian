# 揪時間：技術說明

> 這份文件是給工程師看的：架構、資安設計、部署與測試。想知道揪時間是什麼、怎麼用，請看 [README](../README.md)。

## 架構

純 HTML/CSS/JavaScript，不需要 Node.js 或打包工具；資料庫與即時同步用 Supabase（免費方案）。

## 部署

| 項目 | 位置 |
|---|---|
| 網站 | https://hchunkai821.github.io/jiushijian/ （GitHub Pages） |
| 資料庫／即時同步 | Supabase 專案 `jiushijian`（xpnzyefimdywjihxvcda，新加坡） |
| 測試與程式碼品質 | GitHub Actions 每次 push 自動跑測試 + SonarQube Cloud 檢測 |

push 到 `main` 後，GitHub Actions（`.github/workflows/pages.yml`）會把網站檔案部署到 GitHub Pages，約 1 分鐘生效。只上傳 `index.html`、`app.js`、`config.js`、`styles.css`、`favicon.svg`、`sitemap.xml`、`og.png`（分享連結時的預覽圖），`supabase/` 與文件不會出現在網站上。

`supabase/` 裡的 SQL 改了**不會**自動更新資料庫，要到 Supabase 後台 → SQL Editor 執行。為了避免忘記，只要 push 的內容有改到 `supabase/`，GitHub Actions 的 CI 結果會出現黃色警告提醒你。

## 資安與隱私設計

### 資料存取
- 前端只拿得到 Supabase 的 **anon 公開金鑰**（本來就設計給前端用）。資料表對 anon **完全沒有讀寫權限**，所有操作都經過資料庫函式（`security definer`，固定 `search_path`）。
- 讀取只能用 `get_event(活動代碼)` 讀「單一」活動；無法列出所有活動。活動代碼由伺服器產生 12 碼隨機字元（約 7.9×10¹⁷ 種），加上讀取頻率限制，無法猜測或枚舉。
- 主理人密碼雜湊、成員密碼雜湊、登入憑證、頻率限制紀錄都放在 `private` schema，不對外公開（PostgREST 只公開 `public`）。

### 身份驗證
- 主理人與參與者都用 4 位數密碼，以 **bcrypt** 雜湊保存。
- 密碼正確後，伺服器發一組 256 位元隨機 session token 給瀏覽器（資料庫只存 SHA-256 雜湊），之後的寫入都要帶 token。瀏覽器**不保存密碼**。
- 連錯 5 次鎖定，鎖定時間每次加倍（10 分 → 20 分 → 40 分…最長 30 天）；每個 IP 每 10 分鐘最多 30 次嘗試。已登入的裝置不受鎖定影響，所以別人故意輸錯也不會把主理人鎖在外面。
- 主理人可以「重設成員密碼」，會清除該成員密碼並登出他所有裝置；填好的時間保留。
- 從舊版升級：舊成員沒有密碼，第一個用該暱稱設定密碼的人取得它；舊版存在瀏覽器的主理人密碼會自動換成 token 後刪除。

### 防濫用
- 建立活動：每個 IP 每小時 10 個、全站每小時 500 個。寫入每個 IP 每分鐘 120 次，讀取 300 次。
- 每個活動最多 200 人，所有欄位都在資料庫端驗證長度與格式。
- IP 只以「加鹽 SHA-256 雜湊」暫存在頻率限制表，每小時清除超過 1 天的紀錄。

### 前端
- `Content-Security-Policy`：只允許自己的檔案、固定版本的 supabase-js（另有 SRI 雜湊驗證）、Google Fonts 與自己的 Supabase 專案；不允許行內腳本、行內樣式、外部表單、`<base>`、`<object>`、iframe。
- `Referrer-Policy: no-referrer`：活動連結（等同進入鑰匙）不會透過 Referer 外流到 Google 地圖等網站。
- 所有使用者輸入都經過跳脫或用 `textContent` 顯示，防止 XSS。
- 網頁被嵌入其他網站的 iframe 時不啟動（GitHub Pages 無法設定 `frame-ancestors`，用這個方式防點擊劫持）。
- 活動頁加上 `noindex`，搜尋引擎不會收錄。

### 個資
- 不需要註冊，不收集 email、電話、真實姓名。只儲存活動資訊、暱稱、勾選的時段。
- 活動建立 90 天後由 pg_cron 自動刪除，成員、密碼雜湊、登入憑證一併刪除（`on delete cascade`）。
- 首頁有隱私說明。

### 已知限制（設計上的取捨）
- **知道活動連結的人就能看到這個活動的所有內容**（暱稱、時段、地點）。這是「免註冊、傳連結就能用」的前提；請只把連結傳給參加的人。
- 4 位數密碼只有一萬種組合，靠鎖定機制擋暴力破解：在 90 天內，攻擊者對單一帳號最多只能試約 80 次（成功機率約 0.8%）。被猜中最多只能修改該成員的時間，看不到其他資料。
- Google Fonts 會從 Google 伺服器載入字型（Google 會看到訪客 IP，但不會收到活動網址）。
- 即時同步的廣播頻道只傳「有變動」的通知，不含資料；有人亂送通知最多讓瀏覽器多重新讀取幾次（有頻率限制）。

回報資安問題請見 [SECURITY.md](../SECURITY.md)。

## 第一次設定（或換新的 Supabase 專案）

1. Supabase 後台 → SQL Editor，依序執行 `supabase/schema.sql`、`migrations/002`、`003`、`004`、`005`（已在使用中的專案只要執行 `005`）。
2. Database → Extensions 確認 `pg_cron` 已開啟（`005` 會自動排程清除工作）。
3. **Authentication → Sign In / Providers → 關閉「Allow new users to sign up」**。網站沒有用到帳號登入，關掉可以避免有人用公開金鑰註冊大量帳號。
4. Realtime → Settings 保持允許 public channels（即時同步用）。
5. Advisors → Security Advisor 跑一次。預期只會看到兩類提示，都是刻意的設計：
   - `rls_enabled_no_policy`（INFO）：資料表沒有任何 policy＝前端完全不能直接存取。
   - `anon_security_definer_function_executable`（WARN）：列出的 13 個函式就是網站的 API，每個都會檢查活動代碼、token 與輸入格式。
   除此之外的警告都要處理。
6. 把 Project URL 與 anon key 填進 `config.js`，並把 `index.html` 的 `Content-Security-Policy` 裡 `connect-src` 的網址換成新的專案網址。
7. **千萬不要**把 `service_role` 金鑰放進任何前端檔案或 repo。

## 自動化測試與 SonarQube

每次 push 或開 PR，GitHub Actions（`.github/workflows/ci.yml`）會：

1. 啟動測試用的 Supabase Postgres 與 PostgREST，依序執行 `supabase/` 裡所有 SQL（005 會跑兩次，確認可以重複執行）
2. 跑 **資料庫資安測試**（`tests/db.test.mjs`）：只用公開金鑰從 API 嘗試直接讀寫資料表、冒名、偽造 token、暴力猜密碼、繞過頻率限制、注入等攻擊
3. 跑 **瀏覽器端對端測試**（`tests/e2e.test.mjs`）：用 Chromium 實際操作建立活動、劃記、換裝置、主理人管理、手機觸控、iframe 嵌入等，並檢查沒有 JavaScript 錯誤或 CSP 違規，同時收集 `app.js` 的測試覆蓋率
4. 用 **SonarQube Cloud** 檢測程式碼品質與覆蓋率，品質門檻（Quality Gate）沒過就會失敗

任何一步失敗，GitHub 上的 commit 旁邊會出現紅色叉叉。

### 在自己電腦上跑測試
需要 Docker 與 Node.js：
```bash
npm ci --ignore-scripts
./node_modules/.bin/playwright install chromium
npm run test:setup      # 啟動測試資料庫（第一次要下載映像檔，比較久）
npm test
npm run test:teardown   # 關掉測試資料庫
```

### SonarQube Cloud 設定（已完成）
- 專案：https://sonarcloud.io/project/overview?id=hchunkai821_jiushijian
- 已關閉 Automatic Analysis，改由 GitHub Actions 掃描
- GitHub repo 的 secret `SONAR_TOKEN` 已設定；如果之後失效，到 sonarcloud.io → My Account → Security 產生新的 token，再到 repo 的 Settings → Secrets and variables → Actions 更新

## 檔案結構

```
index.html            網頁骨架（含 CSP 與 Referrer-Policy）
styles.css            樣式（顏色、字體、版面）
app.js                主程式：劃記、熱力圖、推薦演算法、分享、定案、登入
config.js             Supabase 網址與 anon 公開金鑰
favicon.svg           網站圖示
og.png                分享到 LINE 等通訊軟體時的預覽圖
sitemap.xml           給搜尋引擎的首頁網址
supabase/schema.sql   第一版資料表
supabase/migrations/  之後的資料庫修改（005 是資安強化）
tests/                自動化測試（資料庫資安測試、瀏覽器端對端測試）
.github/workflows/    GitHub Pages 部署、CI（測試 + SonarQube）
sonar-project.properties  SonarQube 設定
package.json          測試工具（網站本身不需要 Node.js）
docs/                 說明文件與 README 用的圖片
```

常改的地方：
- **文字**：幾乎都在 `app.js`，直接搜尋畫面上看到的中文字。
- **顏色**：`styles.css` 最上面的 `:root { --accent: ... }`，下面那組是深色模式。
- **活動預設值**（例如預設 30 分鐘一格、09:00–22:00）：`app.js` 的 `showHome` 函式。

## 資料格式
每個人的劃記存成 bitset（每格 1 bit，再轉 base64），推薦演算法在瀏覽器即時計算，見 `app.js` 的 `rankSlots`。

## 免費方案的注意事項
- Supabase 專案一週沒人使用會自動暫停，資料不會刪，到 supabase.com 按 **Restore** 即可。

## 本機測試
不能直接雙擊 `index.html`（瀏覽器會擋 `file://`），請用本機伺服器：
```bash
python3 -m http.server 8000
```
