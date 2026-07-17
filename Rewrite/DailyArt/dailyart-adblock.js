/**
 * DailyArt AdBlock for Surge
 *
 * Only blocks Google Mobile Ads requests under /mads/ on the host observed
 * in the supplied HAR. Other DoubleClick paths are passed through.
 */

const BLOCKED_HOST = "googleads.g.doubleclick.net";
const BLOCKED_PATH_PREFIX = "/mads/";

try {
  const url = new URL($request.url);
  const shouldBlock =
    url.hostname.toLowerCase() === BLOCKED_HOST &&
    url.pathname.startsWith(BLOCKED_PATH_PREFIX);

  if (shouldBlock) {
    console.log(`[DailyArt AdBlock] Blocked: ${$request.url}`);
    $done({
      response: {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        },
        body: ""
      }
    });
  } else {
    $done({});
  }
} catch (error) {
  console.log(`[DailyArt AdBlock] Invalid URL; passed through: ${error}`);
  $done({});
}
