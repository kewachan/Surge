/**
 * General AdBlock for Surge
 *
 * The blocklist is updated from advertising traffic confirmed in HAR captures.
 * Keep consent, analytics, crash reporting, and first-party API traffic out of
 * this list unless they are independently confirmed to deliver advertising.
 */

const BLOCKED_DOMAINS = [
  "googleads.g.doubleclick.net"
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
