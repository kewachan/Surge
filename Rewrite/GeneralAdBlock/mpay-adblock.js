/**
 * MPay AdBlock for Surge — v1.0.4
 * Removes the Home screen floating promotion and replaces mCard campaign art
 * with MPay's official neutral icon in native inactive and focused sizes.
 */

(function () {
  "use strict";

  const ENDPOINT = /^https:\/\/pay\.macaupass\.com\/tdrmp\/appMenu\/getAppMenu\.do(?:\?.*)?$/;
  const MCARD_ICON_SOURCE =
    "https://oss-mpay-prd.macaupass.com/mpay_prd/appMenu/IMAGE_202311031427502c8da5d58848.png";
  const MCARD_ICON = MCARD_ICON_SOURCE +
    "?x-oss-process=image/resize,m_lfit,w_52,h_52/gray,1";
  const MCARD_ICON_SELECTED = MCARD_ICON_SOURCE +
    "?x-oss-process=image/resize,m_lfit,w_64,h_64";

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

        if (item.logo !== MCARD_ICON ||
            item.logoSelected !== MCARD_ICON_SELECTED ||
            item.animeEffect !== null) {
          item.logo = MCARD_ICON;
          item.logoSelected = MCARD_ICON_SELECTED;
          item.animeEffect = null;
          changed = true;
        }
      });
    }

    $done(changed ? { body: JSON.stringify(payload) } : {});
  } catch (_) {
    // Preserve malformed or future response layouts instead of affecting MPay.
    $done({});
  }
})();
