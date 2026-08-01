/**
 * Damai splash ad blocker for Surge.
 *
 * Return a successful empty MTop payload instead of rejecting the request.
 * Damai falls back to a previously cached splash ad when the request fails.
 */

const body = JSON.stringify({
  api: "mtop.damai.wireless.home.welcome",
  data: {},
  ret: ["SUCCESS::调用成功"],
  v: "1.3"
});

$done({
  response: {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    },
    body: body
  }
});
