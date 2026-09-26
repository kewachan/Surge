/**
 * MPay AdBlock for Surge — v1.0.3
 * Removes the Home screen floating promotion and mCard promotional artwork
 * while preserving the app's default navigation and built-in icon fallback.
 */

(function () {
  "use strict";

  const ENDPOINT = /^https:\/\/pay\.macaupass\.com\/tdrmp\/appMenu\/getAppMenu\.do(?:\?.*)?$/;
  const MCARD_PROMOTIONAL_FIELDS = [
    "logo",
    "logoSelected",
    "animeEffect",
    "menuNameColor"
  ];

  if ($request.method !== "POST" || !ENDPOINT.test($request.url) ||
      Number($response.status) !== 200 || typeof $response.body !== "string") {
    $done({});
    return;
  }

  try {
    const payload = JSON.parse($response.body);
    const data = payload && payload.DATA;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      $done({});
      return;
    }

    let changed = false;

    if (Array.isArray(data["10"])) {
      const filtered = data["10"].filter(function (item) {
        return !item || item.code !== "fubiao_ios";
      });
      if (filtered.length !== data["10"].length) {
        data["10"] = filtered;
        changed = true;
      }
    }

    if (Array.isArray(data["4"])) {
      data["4"].forEach(function (item) {
        if (!item || item.code !== "mCard_page_v2_new") return;

        MCARD_PROMOTIONAL_FIELDS.forEach(function (field) {
          if (!Object.prototype.hasOwnProperty.call(item, field)) return;
          delete item[field];
          changed = true;
        });
      });
    }

    $done(changed ? { body: JSON.stringify(payload) } : {});
  } catch (_) {
    // Preserve malformed or future response layouts instead of affecting MPay.
    $done({});
  }
})();
