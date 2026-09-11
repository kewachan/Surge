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
- 提供自定義 proxy 節點離線及每日流量監察工具。

### Architecture

- Domain／URL 規則優先；需要改 body 時，由現有 GeneralAdBlock module 呼叫每個 App 的獨立 JS。
- THIM Home：`exclusive-banners` response → 清空 `data` → App 隱藏 Privilege Offers carousel。
- Node Offline Monitor：cron → active Profile `[Proxy]` → policy test → 5 次狀態確認 → 狀態轉變通知。
- Proxy Daily Traffic：cron／Panel refresh → per-policy engine counters → 每日持久化累計 → Panel。

### Key Files

- `Filters/filters_block.list` — domain 封鎖。
- `Rewrite/Adrewrite.sgmodule` — 自行維護的 URL rewrite。
- `Rewrite/Advertising.sgmodule` — 外部廣告 regex 資源。
- `Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule` — 統一 script 與 MITM 設定。
- `Rewrite/GeneralAdBlock/thim-adblock.js` — 只移除 THIM Home 的 Privilege Offers placement。
- `Tools/NodeOfflineMonitor/NodeOfflineMonitor.sgmodule` — 自定義節點離線監察設定。
- `Tools/NodeOfflineMonitor/node-offline-monitor.js` — 節點發現、測試及狀態通知。
- `Tools/ProxyTrafficPanel/` — 每個自定義 proxy 的每日下載／上載統計 module 及 script。

### Core Logic

- 先以 HAR 確認目標 request 及是否與核心功能共用。
- 按 domain、URL rewrite、response script 的優先次序選擇處理方式。
- Script 只改目標 response，並同步核對 URL pattern、MITM hostname 及 JS 版本。
- THIM script 驗證成功 envelope 後只將 `data` 改成空陣列；其他 API 或未知格式原樣放行。
- 節點監察從 active Profile `[Proxy]` 動態發現節點；offline／resume 均須連續 5 次一致，每次相隔 5 秒，狀態不變時不重複通知。
- 流量 Panel 每 15 分鐘取樣，按本機日曆日累加 Surge per-policy counters，打開 Panel 時亦即時更新。

### Important Decisions

- 沿用 `GeneralAdBlock.sgmodule` 及 `*-adblock.js` 命名，每個 App 使用獨立 JS。
- 不封鎖登入、付款、風控、推送或核心 API。
- THIM 不封鎖共用圖片 CDN，只攔截獨立 `exclusive-banners` endpoint。
- Surge module 不可修改 `[Proxy Group]`；節點監察使用 `$httpAPI`，不硬編碼節點名。
- 每日流量以 Surge engine counters 為準；engine 重啟後從新 counter 繼續，重啟取樣空窗無法回補。

### Recent Significant Changes

- `2026-09-12` — 新增 Proxy Daily Traffic Panel，以 cron sampler 顯示每個自定義 proxy 的每日流量。
- `2026-09-11` — 節點 offline／resume 改為連續 5 次確認後才更新狀態及通知。
- `2026-09-07` — 新增 active Profile 自定義節點離線監察 module，支援離線／恢復通知。
- `2026-09-06` — 新增 THIM Privilege Offers response rewrite；THIM.har 證實該 endpoint 獨立提供 5 個下方 banners。
- `2026-08-31` — 按要求移除 QQ Browser AdBlock 的 JS、request／response 規則、專用 MITM hostname 及測試；其他規則保留。

### Watch Out

- Module 使用 GitHub raw JS URL；修改本機工作檔不會自動發佈，發佈時須同步 JS 與 module 版本。
- HAR 可驗證 API 已清空；整個 section 是否收合仍須以 THIM 真機 UI 驗收。
- Node Offline Monitor 預設沿用 Profile `proxy-test-url`，未設定時才使用內置 fallback URL。
- Proxy Daily Traffic 需要支援 `/v1/metrics` 的 Surge 版本；若內部 API 未回傳 metrics 原文，可在 module 設定填本機 HTTP API key。

### Start Here

- `README.md`
- `Filters/filters_block.list`
- `Rewrite/Adrewrite.sgmodule`
- `Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule`
- `Tools/NodeOfflineMonitor/NodeOfflineMonitor.sgmodule`
- `Tools/ProxyTrafficPanel/ProxyTrafficPanel.sgmodule`
