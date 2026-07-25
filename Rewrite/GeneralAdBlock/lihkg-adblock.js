/**
 * LIHKG AdBlock for Surge
 *
 * Explicitly disables every configured ad placement before ad cells are created.
 */

try {
  const response = JSON.parse($response.body || "{}");
  const adConfig =
    response.response &&
    response.response.config &&
    response.response.config.ios &&
    response.response.config.ios.ad_config;

  if (!adConfig) {
    $done({});
  } else {
    const placements = {
      "0": [
        "applovin_bottom_banner",
        "applovin_bottom_banner_native",
        "gad_bottom_banner"
      ],
      "1": [
        "applovin_topiclist_banner",
        "applovin_topiclist_mrec",
        "applovin_topiclist_native",
        "direct_banner_topic",
        "direct_native_topic",
        "gad_topic_banner"
      ],
      "2": [
        "direct_fullpage",
        "gad_fullpage_post_back"
      ],
      "3": [
        "applovin_post_content",
        "applovin_post_content_dev",
        "applovin_post_content_fallback",
        "applovin_post_content_native",
        "applovin_post_content_prime",
        "gad_post_banner",
        "gad_post_native",
        "webview"
      ],
      "4": [
        "applovin_support_us_fullpage",
        "direct_fullpage",
        "gad_fullpage_support_us",
        "gad_reward_ad"
      ],
      "5": [
        "applovin_game_reward",
        "applovin_support_us_fullpage",
        "gad_fullpage_support_us",
        "gad_reward_ad"
      ]
    };

    adConfig.available_types = [];
    adConfig.delivery = adConfig.delivery || {};

    Object.keys(placements).forEach(function(groupKey) {
      const group = adConfig.delivery[groupKey] || {};

      placements[groupKey].forEach(function(placementKey) {
        const placement = group[placementKey] || {};
        placement.rate = 0;
        placement.backfill = [];
        group[placementKey] = placement;
      });

      adConfig.delivery[groupKey] = group;
    });

    $done({ body: JSON.stringify(response) });
  }
} catch (_) {
  $done({});
}
