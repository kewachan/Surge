# Surge

## Lists

- [`Filters/filters_assigned.list`](Filters/filters_assigned.list) — 需要由使用者指定代理或策略的服務規則。
- [`Filters/filters_block.list`](Filters/filters_block.list) — 封鎖廣告、追蹤器及其他不需要連線的網域與 IP。
- [`Filters/filters_correction.list`](Filters/filters_correction.list) — 修正上游規則造成的錯誤封鎖。
- [`Filters/filters_direct.list`](Filters/filters_direct.list) — 必須直接連線的服務及網址規則。
- [`Filters/filters_macau.list`](Filters/filters_macau.list) — 需要使用澳門網絡或澳門節點的服務規則。

## Modules

- [`Rewrite/Adrewrite.sgmodule`](Rewrite/Adrewrite.sgmodule) — 自行維護的廣告封鎖、拒絕及重新導向規則。
- [`Rewrite/Advertising.sgmodule`](Rewrite/Advertising.sgmodule) — 合併外部來源的廣告 URL Rewrite 規則。
- [`Rewrite/Bilibili/Bilibili.Enhance.sgmodule`](Rewrite/Bilibili/Bilibili.Enhance.sgmodule) — Bilibili 介面增強、功能調整及廣告移除。
- [`Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule`](Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule) — 透過各服務的 response script 移除廣告及推廣內容。
- [`Rewrite/Youtube/YouTube.Enhance.sgmodule`](Rewrite/Youtube/YouTube.Enhance.sgmodule) — YouTube 與 YouTube Music 功能增強、介面調整及字幕／歌詞翻譯。
- [`Tools/NetworkInfo/NetworkInfo.sgmodule`](Tools/NetworkInfo/NetworkInfo.sgmodule) — 顯示目前代理的國家、網絡供應商及公網 IPv4。
- [`Tools/NodeOfflineMonitor/NodeOfflineMonitor.sgmodule`](Tools/NodeOfflineMonitor/NodeOfflineMonitor.sgmodule) — 定時監察代理節點離線及恢復狀態並發出通知。
