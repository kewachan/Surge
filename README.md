# General Ad Block

本專案根據 HAR 分析廣告、追蹤及推廣請求，並使用最簡單而有效的方法處理。除非另有指示，更新時依照以下優先次序。

## 處理優先次序

1. 普通 domain rule：`Filters/filters_block.list`
2. URL regex block 或 redirect：`Rewrite/Adrewrite.sgmodule`
3. 外部廣告 regex 資源：`Rewrite/Advertising.sgmodule`
4. 前三種方法無法處理才使用 response script：`Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule`

能用較簡單的方法有效處理時，不要再加入較複雜的方法，亦不要在多個檔案重複處理同一請求。

## Filters/filters_block.list

- 用途：普通以 domain 為基礎的封鎖。
- 來源：通常從 HAR 判斷可安全封鎖的廣告或追蹤 domain。
- 新增 HAR 分析所得規則到 `#AI Generated`，按地區及公司 comment 放入現有位置；沒有合適分類才新增分類。
- 外部清單合併到 `# Imported List`，保留來源 comment，合併後對全份清單除重複。
- 不要封鎖登入、付款、風控、推送、核心 API、HTTPDNS 或可能令 App 不停載入的 domain。

## Rewrite/Adrewrite.sgmodule

- 用途：自行維護的 URL regex block、reject 及 redirect。
- 來源：主要是澳門 App，也可加入從 HAR 明確判斷、適合用 regex 處理的請求。
- 只有 domain rule 無法精確處理、而特定 URL endpoint 可安全封鎖或重新導向時才加入。
- HTTPS rewrite 需要的 hostname 才加入 `[MITM]`，並保持 rewrite 與 MITM hostname 對應。

## Rewrite/Advertising.sgmodule

- 用途：合併及維護外部作者提供的 advertising regex block。
- 更新方法：從 README 或 module 內記錄的外部來源更新，合併後移除重複或可安全整合的 regex。
- 同步核對 `[URL Rewrite]` 與 `[MITM]`：移除沒有 rewrite 使用的 hostname，補回 rewrite 所需 hostname。
- 由 HAR 產生的個別 App 規則不要放入此檔案。

## Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule

- 用途：根據 HAR，在 domain rule 及 URL rewrite 都無法有效處理時修改 response body。
- 保持一個統一的 General AdBlock module，但每個 App 或網站在 `Rewrite/GeneralAdBlock/` 使用獨立 JavaScript，避免修改一個服務時影響其他服務。
- Script pattern 應盡量精確，只加入必需的 MITM hostname；不要建立共用的 general response JavaScript。
- 修改後應以 HAR 內的實際 response 測試，確認目標元素已移除且原有功能正常。

## Codex Project Context

### Purpose

- 以 HAR 證據精確封鎖廣告／推廣，保留閱讀、登入、付款及會員權益邏輯。

### Architecture

- Domain／URL 規則優先；需要改 body 時，由現有 GeneralAdBlock module 呼叫每個 App 的獨立 JS。
- QQ Reader：指定 ZIP response → 解開外層 ZIP → 修改內層 bundle 的單一推廣分支 → 更新 CRC 並重壓外層。

### Key Files

- `Filters/filters_block.list` — domain 封鎖。
- `Rewrite/Adrewrite.sgmodule` — 自行維護的 URL rewrite。
- `Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule` — 統一 script 與 MITM 設定。
- `Rewrite/GeneralAdBlock/qq-browser-adblock.js` — QQ 閱讀器底部會員／工具推廣移除；內嵌 MIT 授權 fflate 0.8.3。
- `tests/qq-browser-adblock.test.cjs` — 記憶體內 ZIP、失敗放行、顯示分支及可選 HAR 回歸測試。

### Core Logic

- QQ 只攔截指定 Shiply CDN 的正式版 `novelReader.zip.zip`；request script 只移除完整下載的條件快取 headers，Range request 不改。
- response script 只處理 HTTP 200 binary body，輸入上限 8 MiB、解壓上限 12 MiB，驗證 ZIP 結構及目標 CRC。
- 根據 Qq.har 的 reader VC=2517 程式特徵，把 `renderBottomAd` 內會員／工具推廣分支改為 `null`；保留 bundle 長度及其他內層檔案。
- 不改正常廣告分支、章節內容或 VIP 狀態；未知特徵、重複匹配或無效 ZIP 原樣放行。

### Important Decisions

- 沿用 `GeneralAdBlock.sgmodule` 及 `*-adblock.js` 命名，不另建 QQ module。
- 底部會員推廣是 reader 程式內的 fallback，不能靠封鎖圖片或整個 `pbprx.qq.com` 精確移除。
- Codec 已內嵌，執行時無需下載依賴或啟動 Worker。

### Recent Significant Changes

- `2026-08-31` — 新增 QQ binary rewrite；11 項測試通過，實際 HAR 內僅 index bundle 改動，其餘 84 檔保留，兩層 ZIP 通過獨立 CRC 驗證。

### Watch Out

- HAR 測試不等於真機驗收：QQ 的離線資源快取、原生完整性校驗及 iOS 執行限制仍須實機確認；request header 修改不會清除 App 既有資源。
- Module 使用 GitHub raw JS URL；修改本機工作檔不會自動發佈，發佈時須同步 JS 與 module 版本。
- 測試：`node tests/qq-browser-adblock.test.cjs`；可加 HAR 路徑作參數，測試不會儲存解包內容或 HAR 個人資料。

### Start Here

- `README.md`
- `Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule`
- `Rewrite/GeneralAdBlock/qq-browser-adblock.js`
- `tests/qq-browser-adblock.test.cjs`
