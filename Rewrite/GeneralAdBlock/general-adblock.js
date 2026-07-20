/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

let body = $response.body || "";
const isGoogleSearch = $request.url.includes("www.google.com/search");
const url = $request.url;
const likelyShoppingFromURL = /tbm=shop|\bshopping\b/.test(url) && !/shoppingapi|shopping\.google/.test(url);
const detectShoppingFromURL = isGoogleSearch && !/\bsearchbyimage\b/.test(url) && likelyShoppingFromURL;

// Google Search & Shopping: hide ad blocks that cannot be blocked by simple rules.
if (isGoogleSearch) {
  const inject = `
<script>
(function() {
  function collectShopping() {
    var href = (location && location.href) ? location.href.toLowerCase() : "";
    if (href.indexOf("tbm=shop") >= 0) { return true; }
    if (href.indexOf("/shopping") >= 0) { return true; }
    var udm = href.match(/(?:\?|&)udm=([^&]+)/);
    if (udm && udm[1] && udm[1] !== "0") {
      return true;
    }
    var tab = document.querySelector(".N54PNb, [role='tablist'] [role='tab'], .hdtb-mitem");
    if (tab && tab.querySelector && tab.querySelector("a[aria-current='page'],a[aria-selected='true'], .YmvwI, [aria-label='Shopping']")) {
      return true;
    }
    var shoppingHeading = document.querySelector("[jsname='xBNgKe'][class*='mXwfNd'], [aria-label='Shopping']");
    if (shoppingHeading && shoppingHeading.textContent && shoppingHeading.textContent.toLowerCase().indexOf("shopping") >= 0) {
      return true;
    }
    return false;
  }

  var isShoppingPage = ${detectShoppingFromURL} || collectShopping();

  function injectStyle() {
    if (document.getElementById("__googleShoppingBlockerCSS")) {
      return;
    }
    var s = document.createElement("style");
    s.id = "__googleShoppingBlockerCSS";
    s.textContent =
      "#tads,#tadsb,[role='region'][aria-label='Ads'],[aria-label='Shopping ads'],[aria-label='Sponsored'],[aria-label='Sponsored result'],[aria-label='Ads'],.sh-dgr__content,.sh-dlr__content,.pla-result,[data-entity='shopping-ads'],[data-entity='pla'],[data-entity='shopping-search-results'],[data-entity='shopping-result'],.xpdopen,.M8OgIe,.dWz1gf {display:none!important;}" +
      "a[href*='pagead'],img[src*='pagead'],img[src*='googlesyndication'],script[src*='adservice'],script[src*='pagead'],iframe[src*='pagead']{display:none!important;}";
    if (document.head) {
      document.head.appendChild(s);
    }
  }

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
      ".sh-sf",
      ".pla-result",
      ".xpdopen"
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

    if (window.navigator && navigator.sendBeacon) {
      var oldBeacon = navigator.sendBeacon;
      navigator.sendBeacon = function(url, data) {
        if (shouldBlockAdRequest(url)) {
          return true;
        }
        return oldBeacon.call(navigator, url, data);
      };
    }
  }

  function onReady() {
    isShoppingPage = collectShopping() || isShoppingPage;
    injectStyle();
    hideSponsoredNodes(document, isShoppingPage);
    patchNetwork();
  }

  onReady();
  var mo = new MutationObserver(function(){ hideSponsoredNodes(document, isShoppingPage); });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
</script>`;

  if (body.includes("</head>")) {
    body = body.replace("</head>", inject + "</head>");
  } else if (body.includes("</body>")) {
    body = body.replace("</body>", inject + "</body>");
  }
}

$done({ body });
