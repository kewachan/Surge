// Argument-aware replacements for optional static ad rules.
(function () {
  "use strict";
  function enabled(name, fallback = true) {
    const match = new RegExp(`(?:^|&)${name.replace(/\./g, "\\.")}=([^&]*)`).exec(typeof $argument === "string" ? $argument : "");
    if (!match) return fallback;
    return /^(?:true|1)$/i.test(decodeURIComponent(match[1]).replace(/^['"]|['"]$/g, ""));
  }
  try {
    const url = $request.url || "";
    if (!/^(?:GET|POST)$/i.test($request.method || "GET")) return $done({});
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return $done({});
    const path = parsed.pathname;
    let setting, payload = {};
    if (parsed.hostname === "api.vc.bilibili.com") {
      if (/^\/search_svr\/v\d\/Search\/recommend_words(?:\/|$)/.test(path)) setting = "Search.HotSearch";
      else if (path === "/topic_svr/v1/topic_svr") setting = "Dynamic.HotTopics";
      else if (path === "/dynamic_svr/v1/dynamic_svr/mix_uplist") setting = "Dynamic.MostVisited";
    } else if (parsed.hostname === "api.live.bilibili.com" && path === "/xlive/e-commerce-interface/v1/ecommerce-user/get_shopping_info") setting = "Xlive.AD";
    else if (parsed.hostname === "api.bilibili.com" && path === "/pgc/activity/deliver/material/receive") {
      setting = "PGC.AD";
      payload = {code: 0, data: {closeType: "close_win", container: [], showTime: ""}, message: "success"};
    } else if (/^(?:grpc|app)\.bili(?:bili\.com|api\.net)$/.test(parsed.hostname)
      && path === "/bilibili.app.interface.v1.Search/DefaultWords") {
      if (!enabled("Search.HotSearch")) return $done({});
      return $done({response: {status: 200, headers: {"Content-Type": "application/grpc", "grpc-status": "0"}, body: new Uint8Array(5)}});
    }
    if (!setting || !enabled(setting, setting !== "Dynamic.MostVisited")) return $done({});
    $done({response: {status: 200, headers: {"Content-Type": "application/json; charset=utf-8"}, body: JSON.stringify(payload)}});
  } catch (_) { $done({}); }
})();
