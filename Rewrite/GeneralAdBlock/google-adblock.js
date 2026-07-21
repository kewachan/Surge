/**
 * Google AdBlock for Surge
 * 
 * Response + DOM blocking for Google Search sponsored content.
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
      "#tads,#tadsb,.qGXjvb,.vbIt3d,.IuoSj,[role='region'][aria-label='Ads'],[role='region'][aria-label='Shopping ads'],[aria-label='Sponsored'],[aria-label='Sponsored result'],[aria-label='Ads'],.sh-dgr__content,.sh-dlr__content,.pla-result,[data-entity='shopping-ads'],[data-entity='pla'],[data-entity='shopping-search-results'],[data-entity='shopping-result'],.xpdopen,.M8OgIe,.dWz1gf {display:none!important;}" +
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
      ".qGXjvb",
      ".vbIt3d",
      ".IuoSj",
      '[role="region"][aria-label="Ads"]',
      '[role="region"][aria-label="Shopping ads"]',
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

  function normalizeText(v) {
    return (v || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isSponsoredLabelText(text, isShoppingPage) {
    if (!text) { return false; }
    if (text === "sponsored result" || text === "sponsored" || text === "ad" || text === "ads") {
      return true;
    }
    if (isShoppingPage && (text === "shopping ads" || text === "shopping ad" || text === "shopping sponsored result")) {
      return true;
    }
    if (/\b(sponsored|ads?|advertisement|sponsored\s+results|shopping\s+ads|廣告)\b/.test(text)) {
      return true;
    }
    return false;
  }

  function findGoogleAdContainer(node) {
    var p = node;
    for (var i = 0; i < 20 && p; i++) {
      if (p === document || p === null) { return null; }
      var id = p.id || "";
      var role = (p.getAttribute && p.getAttribute("role")) || "";
      var aria = (p.getAttribute && p.getAttribute("aria-label")) || "";
      var cls = (p.className && p.className.toString()) || "";
      var jsname = (p.getAttribute && p.getAttribute("jsname")) || "";
      if (id === "tads" || id === "tadsb") {
        return p;
      }
      if (role === "region" && (aria === "Ads" || aria === "Shopping ads")) {
        return p;
      }
      if (cls.indexOf("qGXjvb") >= 0 || cls.indexOf("vbIt3d") >= 0 || cls.indexOf("IuoSj") >= 0) {
        return p;
      }
      if (jsname === "tY2w9d" || jsname === "ix0Hvc") {
        return p;
      }
      p = p.parentElement;
    }
    return null;
  }

  function hideFromNodeText(root, isShoppingPage) {
    var targets = root.querySelectorAll("span,div,h2,h3,[role='heading'],[aria-label='Sponsored']");
    for (var i = 0; i < targets.length; i++) {
      var n = targets[i];
      var t = normalizeText(n.textContent || "");
      if (!isSponsoredLabelText(t, isShoppingPage)) { continue; }
      var p = findGoogleAdContainer(n);
      if (!p) {
        p = findGoogleAdContainer(n.parentElement);
      }
      if (p) {
        p.style.display = "none";
      }
    }
  }

  function hideSponsoredNodes(root, isShoppingPage) {
    hideAdNodes(root, isShoppingPage);
    hideFromNodeText(root, isShoppingPage);
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
