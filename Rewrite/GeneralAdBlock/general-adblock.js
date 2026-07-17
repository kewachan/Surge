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

const hostname = String($request.hostname || "").toLowerCase();
const url = String($request.url || "");

const domainMatched = BLOCKED_DOMAINS.some(
  domain => hostname === domain || hostname.endsWith(`.${domain}`)
);
const urlMatched = BLOCKED_URL_PATTERNS.some(pattern => pattern.test(url));
const matched = domainMatched || urlMatched;

if (matched) {
  console.log(`[General AdBlock] Matched: ${url || hostname}`);
}

$done({ matched });
