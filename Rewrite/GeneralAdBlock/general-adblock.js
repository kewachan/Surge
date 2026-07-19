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
const hostname = String($request.hostname || "").toLowerCase();
const matched = BLOCKED_DOMAINS.some(
  domain => hostname === domain || hostname.endsWith(`.${domain}`)
);

if (matched) {
  console.log(`[General AdBlock] Blocked: ${url || hostname}`);
}

$done({ matched });
