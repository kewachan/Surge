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
- 提供自定義 proxy 節點離線監察工具。

### Architecture

- Domain／URL 規則優先；需要改 body 時，由現有 GeneralAdBlock module 呼叫每個 App 的獨立 JS。
- Reddit：GraphQL JSON／multipart response → 逐 chunk 移除廣告 edge → 關閉 NSFW 提示 → 重建原格式。
- LINE：專用 domain／path reject 廣告及遙測；`getConfigurations` binary Thrift response 關閉 News tab，同時保留共用 `/S4` endpoint。
- Bilibili：合併 BiliUniverse Enhanced／ADBlock → 本地 fail-closed feed 過濾 → 其餘功能使用固定上游版本 → 額外 PlayPause reject。
- THIM Home：`exclusive-banners` response → 清空 `data` → App 隱藏 Privilege Offers carousel。
- YouTube／YouTube Music：播放初始化 request → `youtube-init` media Worker；字幕 → Google Translate public endpoint；歌詞有有效私人 Bearer token 時 → `youtube-lyrics-translate` Worker → AI cache hit 即回 AI，cache miss 先回 Google 並以 `waitUntil` 背景預熱 Workers AI，否則由裝置直接使用 Google Translate。
- Node Offline Monitor：cron → active Profile `[Proxy]` → policy test → 5 次狀態確認 → 維護時段閘門 → 狀態轉變通知。

### Key Files

- `Filters/filters_block.list` — domain 封鎖。
- `Rewrite/Adrewrite.sgmodule` — 自行維護的 URL rewrite。
- `Rewrite/Advertising.sgmodule` — 外部廣告 regex 資源。
- `Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule` — 統一 script 與 MITM 設定。
- `Rewrite/GeneralAdBlock/reddit-adblock.js` — Reddit JSON／GraphQL multipart 廣告及 NSFW response 過濾。
- `Rewrite/Bilibili/bilibili.feed.response.js` — 無網絡補位、失敗時不回退廣告內容的首頁 feed 過濾。
- `Rewrite/Youtube/YouTube.Enhance.sgmodule`、`Rewrite/Youtube/youtube.worker.js`、`Rewrite/Youtube/youtube.lyrics.worker.js` — YouTube client scripts、media Worker 及獨立 lyrics Worker。
- `Tools/NodeOfflineMonitor/node-offline-monitor.js` — 節點發現、測試及狀態通知。

### Core Logic

- 先以 HAR 確認目標 request 及是否與核心功能共用。
- 按 domain、URL rewrite、response script 的優先次序選擇處理方式。
- Script 只改目標 response，並同步核對 URL pattern、MITM hostname 及 JS 版本。
- Reddit script 同時處理普通 JSON 與 `multipart/mixed` GraphQL chunks；移除 `adPayload`、`AdMetadataCell`、`isAdPost` 或 `AdPost` 節點後保留原 boundary。
- LINE script 只在 binary Thrift map 找到精確 key、單字元長度及 `Y` 值時改為 `N`；其他 `/S4` response 原樣放行。
- LINE 靜態規則按類型分流：專用 hostname 放 `filters_block.list`，共享 hostname 的廣告／遙測 path 放 `Adrewrite.sgmodule`。
- Bilibili 首頁 feed 由本地 response script 直接移除廣告及可選活動大圖，不改 request、亦不發補位 request；其他功能保留固定上游 script。
- THIM script 驗證成功 envelope 後只將 `data` 改成空陣列；其他 API 或未知格式原樣放行。
- 字幕 script 在約 7.5 秒 client 時限內分批並行呼叫 Google Translate，結果在 client 快取 7 日；歌詞 client 以最多 12 行／600 字組成邏輯批次。Worker 的 AI cache 命中時即回 Cloudflare AI；miss 時先回 Google、同時以 `waitUntil` 背景 AI 預熱。AI 結果快取 14 日，臨時 Google client cache 只保留 2 分鐘。
- 歌詞 Worker 按用戶選擇的目標語言及文字系統逐行判斷；本身已精確符合目標的行必須原樣返回，client 不會重複疊加該行或顯示翻譯署名；`zh-Hant`／`zh-Hans` 仍會正確互轉。
- 節點監察從 active Profile `[Proxy]` 動態發現節點；offline／resume 均須連續 5 次一致，每次相隔 5 秒，狀態不變時不重複通知。
- 每日 UTC+8 04:25–05:15 維護靜默時段仍會檢測及記錄 log，但不通知或覆寫 persistent state；時段結束後才以原有狀態重新確認。

### Important Decisions

- 沿用 `GeneralAdBlock.sgmodule` 及 `*-adblock.js` 命名，每個 App 使用獨立 JS。
- Reddit 不使用 JQ Body Rewrite；Home Feed 的 `multipart/mixed` response 必須由專用 JS 逐 chunk 解析。
- 不封鎖登入、付款、風控、推送或核心 API。
- LINE `/S4` 是共用核心 endpoint，不可封鎖；只可在 binary-body mode 精準修改已驗證的 News flag。
- THIM 不封鎖共用圖片 CDN，只攔截獨立 `exclusive-banners` endpoint。
- Bilibili feed 採用 fail-closed 過濾；網絡異常不得令廣告補位或原始廣告 response 回流。
- Media 與 lyrics Worker 使用獨立 source 及部署；`youtube-init` 不含 AI binding 或翻譯路由。字幕直接連線 Google Translate，歌詞直接連線 `youtube-lyrics-translate`；兩者均設為 DIRECT。歌詞採用 request-local `waitUntil` 背景預熱及 Cache API 狀態／失敗冷卻，不使用 Durable Objects。
- 歌詞 Worker 只可使用 request-local 並行控制；不可在 module scope 儲存跨 invocation 的 in-flight Promise、waiter 或 request-bound I/O。
- `zh-Hant`／`zh-TW` AI 結果如含明確簡體字形必須拒絕且不可寫入 cache，交由 client 使用 Google Translate fallback；正常批次不可為了預先分拆而重複 AI inference。
- 歌詞 Worker 的共用 access token 只存於 Cloudflare Secret；module 預設不包含有效 token，使用者可私下取得並在本機參數輸入；缺少或無效 token 時 client 必須直接改用 Google Translate，不可先呼叫 Worker。
- Surge module 不可修改 `[Proxy Group]`；節點監察使用 `$httpAPI`，不硬編碼節點名。
- Node Offline Monitor 的維護時段由 module arguments 控制，預設 UTC+8 04:25–05:15，包含 05:00 排程並避免計劃重啟產生 offline／resume 通知風暴。

### Recent Significant Changes

- `2026-10-06` — 歌詞改為 Google-first／AI background warm：AI cache hit 即回 AI，miss 先回 Google，背景成功後寫入 14 日 AI cache；臨時 Google client cache 只保留 2 分鐘，並以短期 warming marker／失敗 cooldown 避免重複消耗 AI。
- `2026-10-05` — 歌詞 AI 改為完整 12 行／600 字批次單次 inference，只有無效 JSON 才拆細；加入 `zh-Hant` 簡體字形 guard 並失效舊 Worker／client cache，降低延遲及防止混入簡體。
- `2026-10-05` — 歌詞 client 在 access token 缺失或格式無效時改為直接使用 Google Translate；Google cache 亦只會在存在有效 token 時嘗試升級成 AI 翻譯。
- `2026-10-05` — 歌詞 Worker 移除跨 invocation 的 in-flight Promise／全域等待隊列，改用 request-local 三路 AI 並行；同一 invocation 以 `waitUntil` 在 client 取消後完成 cache，頂層 handler 將早期錯誤轉為正常 HTTP response，避免 `scriptThrewException`。
- `2026-10-05` — 歌詞翻譯改為以 `lyricsLang` 的 exact language／script／locale 逐行判斷；相同行不再重複顯示，繁簡仍按 parameter 互轉，舊 target-unaware cache 同步失效。
- `2026-10-03` — 歌詞 client 恢復 12 行／600 字邏輯批次及完整批次語境，以改善代詞、視角及重複詞一致性；同步更新 cache 版本，避免沿用舊的無語境翻譯。
- `2026-10-01` — 歌詞 Worker 加入私人 Bearer token 驗證；Surge／Loon 均由本機 module 參數傳入，未授權請求不會消耗 Workers AI。
- `2026-10-01` — 字幕改回 Google Translate 並採用限時分批並行；歌詞 Worker 更名為 `youtube-lyrics-translate`、升級語意模型並與 media source 完全分離，舊 caption Worker／AI 分支移除。
- `2026-09-30` — YouTube media 與 translation Worker 分拆；translation 加入 7 日 Cache API，module 將 translation Worker 明確設為 DIRECT。
- `2026-09-28` — Node Offline Monitor 維護靜默時段調整為 UTC+8 04:25–05:15，確保 05:00 排程仍靜默；檢測照常執行，但不通知或保存錯誤／狀態變更。
- `2026-09-16` — LINE 加入專用 domain／path 廣告及遙測封鎖，並以 binary Thrift feature flag 隱藏 News tab；共用 `/S4` 保持可用。
- `2026-09-16` — Reddit 去廣告由 JQ 改為專用 JSON／multipart parser，支援 deferred Home Feed 並保留 NSFW 解鎖。
- `2026-09-12` — Bilibili 首頁 feed 改用本地純過濾 script，移除上游補位 request、5 秒 timeout 及原始廣告 fallback 路徑。
- `2026-09-11` — 節點 offline／resume 改為連續 5 次確認後才更新狀態及通知。

### Watch Out

- Module 使用 GitHub raw JS URL；修改本機工作檔不會自動發佈，發佈時須同步 JS 與 module 版本。
- `youtube-init` 使用 `wrangler.jsonc`；`youtube-lyrics-translate` 使用 `wrangler.lyrics.jsonc`，兩者沒有 service binding，可獨立部署。
- Cloudflare request context 不可跨 invocation 共用；歌詞 Worker 不可重新加入 module-scope Promise coalescing 或全域 waiter queue。
- `Lyrics Access Token` 留空或無效時歌詞仍會使用 Google Translate；輸入私下取得的 64 字元 token 才會啟用 Workers AI。不可將實際 token commit 到 repository。
- Reddit `HomeFeedWithDefer` 使用 `multipart/mixed; boundary=graphql`；不可退回只接受單一 JSON 的 JQ rule。
- HAR 可驗證 API 已清空；整個 section 是否收合仍須以 THIM 真機 UI 驗收。
- Node Offline Monitor 預設沿用 Profile `proxy-test-url`，未設定時才使用內置 fallback URL。
- Bilibili 非 feed 功能的上游 script URL 固定於已驗證 release；更新時不可把首頁 feed 重新併回有網絡補位的上游流程。

### Start Here

- `README.md`
- `Filters/filters_block.list`
- `Rewrite/Adrewrite.sgmodule`
- `Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule`
- `Rewrite/GeneralAdBlock/reddit-adblock.js`
- `Rewrite/Bilibili/bilibili.feed.response.js`
