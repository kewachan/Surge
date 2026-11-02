(function () {
  "use strict";
  try {
    if (Number($response.status ?? $response.statusCode ?? 200) !== 200 ||
        !/^https?:\/\/comicapi\.manhuashe\.com\//i.test($request.url || "") ||
        typeof $response.body !== "string") return $done({});
    let unsafeNumber = false;
    const json = JSON.parse($response.body, (_key, value) => {
      if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) unsafeNumber = true;
      return value;
    });
    if (!json || typeof json !== "object" || unsafeNumber) return $done({});
    const target = json.response && typeof json.response === "object" ? json.response : json;
    if (!target.base || typeof target.base !== "object" || Array.isArray(target.base) || target.base.welfare_tabbar_show === 0) return $done({});
    target.base.welfare_tabbar_show = 0;
    $done({body: JSON.stringify(json)});
  } catch (_) { $done({}); }
})();
