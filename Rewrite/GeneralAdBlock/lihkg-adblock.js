/**
 * LIHKG AdBlock for Surge
 *
 * Removes topic and in-thread ad definitions before the app creates ad cells.
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
    // Group 1 contains the active 300x250 MREC slot; group 3 contains
    // alternate post-content placements.
    adConfig.delivery["1"] = {};
    adConfig.delivery["3"] = {};

    if (adConfig.creatives) {
      [
        "applovin_topiclist_banner",
        "applovin_topiclist_mrec",
        "applovin_topiclist_native",
        "applovin_post_content",
        "applovin_post_content_dev",
        "applovin_post_content_fallback",
        "applovin_post_content_native",
        "applovin_post_content_prime",
        "direct_banner_topic",
        "direct_native_topic",
        "gad_post_banner",
        "gad_post_native",
        "gad_topic_banner",
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
