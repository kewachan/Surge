/**
 * Damai splash ad blocker for Surge.
 *
 * Preserve the successful MTop response envelope while removing both the
 * welcome payload and the logged-in user's preloaded splash ad list. Damai
 * falls back to a cached splash ad when the request fails, so the upstream
 * request must be allowed to complete normally.
 */

try {
  const response = JSON.parse($response.body || "{}");

  if (!response || typeof response !== "object" || Array.isArray(response)) {
    $done({});
  } else {
    const isPreloadedAdList = ($request.url || "").includes(
      "mtop.film.independentadvertiseapi.querypreloadadvlist"
    );

    response.data = isPreloadedAdList ? { adList: [] } : {};
    $done({ body: JSON.stringify(response) });
  }
} catch (_) {
  $done({});
}
