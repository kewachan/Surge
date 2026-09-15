/**
 * THIM AdBlock for Surge — v1.0.2
 * Removes the Home screen's hero banner and complete Privilege Offers carousel
 * by emptying only their dedicated placement responses.
 */

(function () {
  "use strict";

  const HERO_ENDPOINT = /^https:\/\/service(?:\.global)?\.thim\.immigration\.go\.th\/api\/v1\/explore\/hero-banner(?:\?[^#]*)?$/;
  const OFFERS_ENDPOINT = /^https:\/\/service(?:\.global)?\.thim\.immigration\.go\.th\/api\/v1\/explore\/coupons\/exclusive-banners(?:\?[^#]*)?$/;
  const isHeroBanner = HERO_ENDPOINT.test($request.url);
  const isOffersBanner = OFFERS_ENDPOINT.test($request.url);

  if ($request.method !== "GET" || (!isHeroBanner && !isOffersBanner) ||
      Number($response.status) !== 200 || typeof $response.body !== "string") {
    $done({});
    return;
  }

  try {
    const payload = JSON.parse($response.body);
    if (!payload || payload.code !== "200.00" || payload.status !== "SUCCESS") {
      $done({});
      return;
    }

    if (isHeroBanner) {
      if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
        $done({});
        return;
      }
      payload.data = null;
    } else {
      if (!Array.isArray(payload.data) || payload.data.length === 0) {
        $done({});
        return;
      }
      payload.data = [];
    }

    $done({ body: JSON.stringify(payload) });
  } catch (_) {
    // Preserve malformed or future response layouts instead of affecting THIM.
    $done({});
  }
})();
