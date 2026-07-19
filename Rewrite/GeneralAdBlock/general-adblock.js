/**
 * General AdBlock for Surge
 *
 * The blocklist is updated from advertising traffic confirmed in HAR captures.
 * In addition to advertising, crash-reporting hosts explicitly requested by
 * the user are included. Keep consent and first-party API traffic out of this
 * list unless blocking them is explicitly requested.
 */

const BLOCKED_DOMAINS = [
  // Advertising
  "googleads.g.doubleclick.net",
  "sdkconfig.ad.xiaomi.com", // Xiaomi advertising SDK configuration

  // Crash reporting
  "firebase-settings.crashlytics.com",
  "sentry.dailyart.nodea.net.pl",
  "apmplus.volces.com", // Xiaomi APM, diagnostics, and session telemetry

  // Tracking
  "tracking.miui.com" // Xiaomi behavioural tracking
];

const BLOCKED_URL_PATTERNS = [
  // Add narrowly scoped regular expressions here when blocking an entire
  // advertising hostname would be too broad.
];

const BILIBILI_PLAY_PAUSE =
  "https://grpc.biliapi.net/bilibili.app.viewunite.v1.View/PlayPause";

const url = String($request.url || "");

if ($script.type === "http-response" && url === BILIBILI_PLAY_PAUSE) {
  // The PlayPause response is a gRPC message containing Bilibili's pause-page
  // advertising card. Return a valid uncompressed gRPC frame whose protobuf
  // payload is empty: 1-byte compression flag + 4-byte payload length.
  console.log("[General AdBlock] Removed Bilibili PlayPause advertisement");
  $done({ body: new Uint8Array([0, 0, 0, 0, 0]) });
} else {
  const hostname = String($request.hostname || "").toLowerCase();
  const domainMatched = BLOCKED_DOMAINS.some(
    domain => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  const urlMatched = BLOCKED_URL_PATTERNS.some(pattern => pattern.test(url));
  const matched = domainMatched || urlMatched;

  if (matched) {
    console.log(`[General AdBlock] Matched: ${url || hostname}`);
  }

  $done({ matched });
}
