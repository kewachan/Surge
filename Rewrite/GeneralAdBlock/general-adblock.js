/**
 * General AdBlock for Surge
 *
 * Modes:
 * 1. Rule script: blocks confirmed advertising, crash-reporting, and tracking
 *    hosts collected from HAR captures.
 * 2. HTTP response script: replaces Bilibili's PlayPause advertising payload
 *    with a valid empty gRPC frame.
 */

// MARK: - Domain blocklist

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
  // Add narrowly scoped patterns when blocking an entire host is too broad.
];

// MARK: - Response handlers

const RESPONSE_HANDLERS = {
  BILIBILI_PLAY_PAUSE:
    "https://grpc.biliapi.net/bilibili.app.viewunite.v1.View/PlayPause"
};

// gRPC wire format: compression flag (1 byte) + payload length (4 bytes).
const EMPTY_GRPC_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

function handleRuleRequest(request) {
  const hostname = String(request.hostname || "").toLowerCase();
  const url = String(request.url || "");

  const domainMatched = BLOCKED_DOMAINS.some(
    domain => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  const urlMatched = BLOCKED_URL_PATTERNS.some(pattern => pattern.test(url));
  const matched = domainMatched || urlMatched;

  if (matched) {
    console.log(`[General AdBlock] Blocked: ${url || hostname}`);
  }

  $done({ matched });
}

function handleHttpResponse(request) {
  const url = String(request.url || "");

  if (url === RESPONSE_HANDLERS.BILIBILI_PLAY_PAUSE) {
    console.log("[General AdBlock] Removed: Bilibili PlayPause advertisement");
    $done({ body: EMPTY_GRPC_FRAME });
    return;
  }

  $done({});
}

// MARK: - Entry point

switch ($script.type) {
  case "http-response":
    handleHttpResponse($request);
    break;
  case "rule":
    handleRuleRequest($request);
    break;
  default:
    console.log(`[General AdBlock] Unsupported script type: ${$script.type}`);
    $done({});
}
