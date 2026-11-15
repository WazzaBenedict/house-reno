# 舊屋翻修管理

自行發包翻修用的管理 app：工種與工班報價、時程、預算與付款、驗收清單、待辦，以及工班每日回報。

- 手機、平板、電腦用瀏覽器開同一個網址，可以加到主畫面，沒網路也能開和填寫，連線後自動同步。
- 屋主和家人用 email 登入，看得到全部資料。
- 工班不用註冊，每個工種有一條專屬回報連結，只看得到自己工種的回報。

## 架構

純靜態網頁，沒有建置步驟，放在 GitHub Pages。資料存在 Supabase（登入、資料庫、照片）。

| 檔案 | 用途 |
| --- | --- |
| `index.html`、`app.js`、`styles.css` | app 本體 |
| `config.js` | Supabase 專案網址和公開金鑰 |
| `sw.js`、`manifest.webmanifest`、`icons/` | 離線快取和安裝到主畫面 |
| `vendor/supabase.js` | Supabase 用戶端程式庫（2.45.4） |
| `supabase/schema.sql` | 資料表和權限規則 |

翻修資料不在這個 repo 裡，只存在資料庫。

## 第一次設定

1. **建資料表。** Supabase 後台 → SQL Editor → 貼上 `supabase/schema.sql` 整份 → Run。
2. **設定登入信的回跳網址。** Supabase 後台 → Authentication → URL Configuration，把 Site URL 設成 app 的網址（例如 `https://<帳號>.github.io/house-reno/`）。
3. **開 GitHub Pages。** repo 的 Settings → Pages → Source 選 Deploy from a branch，Branch 選 `main`、資料夾選 `/ (root)`。
4. **建立屋主帳號。** 開 app 網址，按「第一次使用，建立帳號」，到信箱點確認連結後登入。第一個登入的人會成為屋主。
5. **匯入資料。** 設定 → 匯入資料，選翻修資料匯入檔。
6. **加入家人。** 設定 →「可以登入的人」加入對方的 email，對方再用同一個 email 建立帳號。

## 權限怎麼運作

- `members` 表列出可以登入的 email。只有名單裡、而且 email 已驗證的人讀寫得到 `items`。
- 請保持 Supabase 的「Confirm email」開啟。關掉的話，任何人都能用名單上的 email 註冊並進來。
- 工班連結走 `crew_open` 和 `crew_submit` 兩個資料庫函式，只回傳該工種的名稱和回報，不能讀其他資料。作廢連結後舊連結立刻失效。
- 照片存在公開的 `photos` bucket，檔名是亂數。知道完整網址的人可以看到那張照片。

## 更新 app

改完程式後，把 `sw.js` 裡的 `VERSION` 改一個新值再推上去，已安裝的裝置下次開啟會拿到新版。
