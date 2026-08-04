/**
 * Remove mFood launch-screen and popup advertisements.
 *
 * The splash endpoint returns base64-encoded zlib data rather than plain
 * JSON. The popup endpoint returns JSON directly. In both cases, respond
 * with a valid empty list so the app can clear cached advertising data.
 */

const EMPTY_COMPRESSED_LIST = "eJyLjgUAARUAuQ==";
const requestURL = $request.url || "";

if (requestURL.includes("/_list_spread-compress")) {
  $done({ body: EMPTY_COMPRESSED_LIST });
} else if (requestURL.includes("/_comprehensive_pop_list")) {
  $done({ body: "[]" });
} else {
  $done({});
}
