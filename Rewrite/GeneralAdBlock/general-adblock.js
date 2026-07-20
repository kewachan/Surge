/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

let body = $response.body || "";
const isGoogleSearch = $request.url.includes("www.google.com/search");
const isGoogleShopping = isGoogleSearch && ($request.url.includes("tbm=shop") || $request.url.includes("/shopping"));

// Google Search & Shopping: hide ad blocks that cannot be blocked by simple rules.
if (isGoogleSearch || isGoogleShopping) {
  const inject = `
<script>
(function() {
  function shouldBlockAdRequest(url) {
    if (!url) { return false; }
    return url.indexOf("ogads-pa.clients6.google.com") >= 0 ||
           url.indexOf("/$rpc/google.internal.onegoogle.asyncdata.v1.AsyncDataService/GetAsyncData") >= 0 ||
           url.indexOf("pagead/1p-conversion") >= 0 ||
           url.indexOf("googleadservices.com/pagead/conversion") >= 0 ||
           url.indexOf("adservice.google.com") >= 0 ||
           url.indexOf("pagead2.googlesyndication.com") >= 0 ||
           url.indexOf("doubleclick.net") >= 0 ||
           url.indexOf("googlesyndication.com") >= 0;
  }

  function hideAdNodes(root, isShoppingPage) {
    var selectors = [
      "#tads",
      "#tadsb",
      '[role="region"][aria-label="Ads"]',
      '[aria-label="Sponsored result"]',
      '[aria-label="Ads"]',
      '[aria-label="Shopping ads"]',
      '[aria-label="Sponsored"]',
      "[data-entity='shopping-ads']",
      "[data-entity='pla']",
      "[data-entity='shopping-search-results']",
      "[data-entity='shopping-result']",
      ".sh-dgr__content",
      ".sh-dlr__content",
      ".pla-result"
    ];
    selectors.forEach(function(sel) {
      root.querySelectorAll(sel).forEach(function(n){ n.style.display = "none"; });
    });

    if (isShoppingPage) {
      root.querySelectorAll("script,link").forEach(function(n) {
        var src = (n.getAttribute("src") || "").toLowerCase();
        if (src && shouldBlockAdRequest(src)) {
          n.parentElement && n.parentElement.removeChild(n);
        }
      });
    }
  }

  function hideSponsoredNodes(root, isShoppingPage) {
    hideAdNodes(root, isShoppingPage);
    var blocks = root.querySelectorAll("span,div,li,a");
    for (var i = 0; i < blocks.length; i++) {
      var n = blocks[i];
      var t = (n.textContent || "").trim().toLowerCase();
      if (!t) { continue; }
      var isSponsored = t === "sponsored result" || t === "sponsored" || t.startsWith("sponsored ");
      if (isShoppingPage && (t.indexOf("sponsored") >= 0 || t.indexOf("廣告") >= 0 || t.indexOf("advertisement") >= 0)) {
        isSponsored = true;
      }
      if (isSponsored) {
        var p = n.parentElement;
        for (var j = 0; j < 8 && p; j++) {
          if (p.id === "tads" || (p.getAttribute && p.getAttribute("role") === "region") || (isShoppingPage && p.getAttribute && p.getAttribute("role") === "listitem")) {
            break;
          }
          p = p.parentElement;
        }
        if (p) {
          p.style.display = "none";
        }
      }
    }
  }

  function patchNetwork() {
    if (window.__googleAdsPatched__) {
      return;
    }
    window.__googleAdsPatched__ = true;

    var oldFetch = window.fetch;
    if (typeof oldFetch === "function") {
      window.fetch = function(input, init) {
        var url = "";
        if (typeof input === "string") {
          url = input;
        } else if (input && input.url) {
          url = input.url;
        }
        if (shouldBlockAdRequest(url)) {
          return Promise.resolve(new Response("", { status: 204, statusText: "Blocked by Surge script" }));
        }
        return oldFetch.call(this, input, init);
      };
    }

    var oldOpen = XMLHttpRequest.prototype.open;
    var oldSend = XMLHttpRequest.prototype.send;
    if (oldOpen && oldSend) {
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__adTargetUrl = url || "";
        return oldOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        if (shouldBlockAdRequest(this.__adTargetUrl)) {
          try {
            this.abort();
          } catch (e) {}
          return;
        }
        return oldSend.apply(this, arguments);
      };
    }
  }

  function onReady() {
    hideSponsoredNodes(document, ${isGoogleShopping});
    patchNetwork();
  }

  onReady();
  var mo = new MutationObserver(function(){ hideSponsoredNodes(document, ${isGoogleShopping}); });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
</script>`;

  if (body.includes("</body>")) {
    body = body.replace("</body>", inject + "</body>");
  }
}

$done({ body });
