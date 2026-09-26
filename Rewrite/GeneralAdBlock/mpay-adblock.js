/**
 * MPay AdBlock for Surge — v1.0.6
 * Removes the Home screen floating promotion while preserving MPay-provided
 * tabs, icons, animations, and navigation.
 */

(function () {
  "use strict";

  const ENDPOINT = /^https:\/\/pay\.macaupass\.com\/tdrmp\/appMenu\/getAppMenu\.do(?:\?.*)?$/;

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

    $done(changed ? { body: JSON.stringify(payload) } : {});
  } catch (_) {
    // Preserve malformed or future response layouts instead of affecting MPay.
    $done({});
  }
})();
