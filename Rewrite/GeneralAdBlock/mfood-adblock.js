/**
 * Remove mFood launch-screen and popup advertisements.
 *
 * Intercept requests before the real advertising payload reaches the app,
 * with a response-stage fallback for already-started requests. The splash
 * endpoint uses base64-encoded zlib data, popup lists use JSON arrays, and
 * the special-banner endpoint uses an empty body when no ad is available.
 */

const EMPTY_COMPRESSED_LIST = "eJyLjgUAARUAuQ==";
const requestURL = $request.url || "";
const isSplash = requestURL.includes("/_list_spread-compress");
const isPopupList =
  requestURL.includes("/_comprehensive_pop_list") ||
  requestURL.includes("/getGroupPopList");
const isSpecialBanner = requestURL.includes("/_special_list");

if (isSplash || isPopupList || isSpecialBanner) {
  const body = isSplash
    ? EMPTY_COMPRESSED_LIST
    : isSpecialBanner
      ? ""
      : "[]";
  const contentType = isSplash
    ? "text/plain;charset=UTF-8"
    : isSpecialBanner
      ? ""
      : "application/json;charset=UTF-8";

  if (typeof $response === "undefined") {
    const headers = { "Cache-Control": "no-store" };
    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    $done({
      response: {
        status: 200,
        headers,
        body
      }
    });
  } else {
    const headers = { ...($response.headers || {}) };

    for (const name of Object.keys(headers)) {
      const lowerName = name.toLowerCase();
      if (
        lowerName === "content-length" ||
        (isSpecialBanner && lowerName === "content-type")
      ) {
        delete headers[name];
      }
    }

    headers["Cache-Control"] = "no-store";
    if (contentType) {
      headers["Content-Type"] = contentType;
    }
    $done({ headers, body });
  }
} else {
  $done({});
}
