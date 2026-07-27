# General Ad Block

本專案根據 HAR 分析廣告、追蹤及推廣請求，並使用最簡單而有效的方法處理。除非使用者另有指示，更新時依照以下優先次序。

## 處理優先次序

1. 普通 domain rule：`Filters/filters_block.list`
2. URL regex block 或 redirect：`Rewrite/Adrewrite.sgmodule`
3. 外部廣告 regex 資源：`Rewrite/Advertising.sgmodule`
4. 前三種方法無法處理才使用 response script：`Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule`

能用較簡單的方法有效處理時，不要再加入較複雜的方法，亦不要在多個檔案重複處理同一請求。

## Filters/filters_block.list

- 用途：普通以 domain 為基礎的封鎖。
- 來源：通常由使用者提供 HAR，再判斷可安全封鎖的廣告或追蹤 domain。
- 新增 HAR 分析所得規則到 `#AI Generated`，按地區及公司 comment 放入現有位置；沒有合適分類才新增分類。
- 外部清單合併到 `# Imported List`，保留來源 comment，合併後對全份清單除重複。
- 不要封鎖登入、付款、風控、推送、核心 API、HTTPDNS 或可能令 App 不停載入的 domain。

## Rewrite/Adrewrite.sgmodule

- 用途：使用者自行維護的 URL regex block、reject 及 redirect。
- 來源：主要是澳門 App，也可加入從 HAR 明確判斷、適合用 regex 處理的請求。
- 只有 domain rule 無法精確處理、而特定 URL endpoint 可安全封鎖或重新導向時才加入。
- HTTPS rewrite 需要的 hostname 才加入 `[MITM]`，並保持 rewrite 與 MITM hostname 對應。

## Rewrite/Advertising.sgmodule

- 用途：合併及維護外部作者提供的 advertising regex block。
- 更新方法：從 README 或 module 內記錄的外部來源更新，合併後移除重複或可安全整合的 regex。
- 同步核對 `[URL Rewrite]` 與 `[MITM]`：移除沒有 rewrite 使用的 hostname，補回 rewrite 所需 hostname。
- 使用者 HAR 產生的個別 App 規則不要放入此檔案。

## Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule

- 用途：根據使用者提供的 HAR，在 domain rule 及 URL rewrite 都無法有效處理時修改 response body。
- 保持一個統一的 General AdBlock module，但每個 App 或網站在 `Rewrite/GeneralAdBlock/` 使用獨立 JavaScript，避免修改一個服務時影響其他服務。
- Script pattern 應盡量精確，只加入必需的 MITM hostname；不要建立共用的 general response JavaScript。
- 修改後應以 HAR 內的實際 response 測試，確認目標元素已移除且原有功能正常。
