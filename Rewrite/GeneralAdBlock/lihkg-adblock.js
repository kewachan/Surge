/**
 * LIHKG AdBlock for Surge
 *
 * Removes in-thread ad delivery definitions before the app creates ad cells.
 */

try {
  const response = JSON.parse($response.body || "{}");
  const adConfig =
    response.response &&
    response.response.config &&
    response.response.config.ios &&
    response.response.config.ios.ad_config;

  if (!adConfig || !adConfig.delivery) {
    $done({});
  } else {
    // Delivery group 3 contains the large ad cell inserted between replies.
    adConfig.delivery["3"] = {};

    if (adConfig.creatives) {
      [
        "applovin_post_content",
        "applovin_post_content_dev",
        "applovin_post_content_fallback",
        "applovin_post_content_native",
        "applovin_post_content_prime",
        "gad_post_banner",
        "gad_post_native",
        "webview"
      ].forEach(function(key) {
        delete adConfig.creatives[key];
      });
    }

    $done({ body: JSON.stringify(response) });
  }
} catch (_) {
  $done({});
}
