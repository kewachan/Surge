/**
 * Return an immediate successful MTop response before Damai can show its
 * bundled fallback splash or download a logged-in user's preload ad list.
 */

const isPreloadedAdList = ($request.url || "").includes(
  "mtop.film.independentadvertiseapi.querypreloadadvlist"
);

const body = JSON.stringify({
  api: isPreloadedAdList
    ? "mtop.film.independentadvertiseapi.querypreloadadvlist"
    : "mtop.damai.wireless.home.welcome",
  data: isPreloadedAdList ? { adList: [] } : {},
  ret: ["SUCCESS::调用成功"],
  v: isPreloadedAdList ? "1.0" : "1.3"
});

$done({
  response: {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-store",
      "Content-Type": "application/json;charset=UTF-8",
      "Pragma": "no-cache",
      "x-retcode": "SUCCESS"
    },
    body: body
  }
});
