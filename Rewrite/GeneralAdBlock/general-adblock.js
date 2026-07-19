/**
 * General AdBlock for Surge
 *
 * Blocks confirmed advertising, crash-reporting, and tracking hosts collected
 * from HAR captures.
 */

const BLOCKED_DOMAINS = [
  // Advertising
  "sdkconfig.ad.xiaomi.com", // Xiaomi advertising SDK configuration

  // Crash reporting
  "firebase-settings.crashlytics.com",
  "sentry.dailyart.nodea.net.pl",
  "apmplus.volces.com", // Xiaomi APM, diagnostics, and session telemetry

  // Tracking
  "tracking.miui.com" // Xiaomi behavioural tracking
];

const url = String($request.url || "");

if (typeof $response !== "undefined") {
  removeResponseAds();
} else {
  blockDomain();
}

function removeResponseAds() {
  if (!url.includes("api.gamer.com.tw/mobile_app/anime/v4/token.php")) {
    $done({});
    return;
  }

  try {
    const payload = JSON.parse($response.body || "{}");
    const ad = payload?.data?.ad;

    if (ad && typeof ad === "object") {
      ad.major = [];
      ad.minor = [];
      ad.sponsor = {};
      console.log("[General AdBlock] Removed Bahamut Anime pre-roll ads");
    }

    $done({ body: JSON.stringify(payload) });
  } catch (error) {
    console.log(`[General AdBlock] Bahamut response unchanged: ${error}`);
    $done({});
  }
}

function blockDomain() {
  const hostname = String($request.hostname || "").toLowerCase();
  const matched = BLOCKED_DOMAINS.some(
    domain => hostname === domain || hostname.endsWith(`.${domain}`)
  );

  if (matched) {
    console.log(`[General AdBlock] Blocked: ${url || hostname}`);
  }

  $done({ matched });
}
