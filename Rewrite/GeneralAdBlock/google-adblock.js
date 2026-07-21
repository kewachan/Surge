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

  if (body.includes("Ask and explore anything with the Google app")) {
    body = body
      .replaceAll(
        'class=\\"B2VR9 CJHX3e\\"',
        'class=\\"B2VR9 CJHX3e\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="B2VR9 CJHX3e"',
        'class="B2VR9 CJHX3e" style="display:none!important"'
      )
      .replaceAll(
        'class=\\"CJHX3e B2VR9\\"',
        'class=\\"CJHX3e B2VR9\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="CJHX3e B2VR9"',
        'class="CJHX3e B2VR9" style="display:none!important"'
      )
      .replaceAll(
        'class=\\"B2VR9\\"',
        'class=\\"B2VR9\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="B2VR9"',
        'class="B2VR9" style="display:none!important"'
      );
  }

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
      "#tads,#tadsb,.qGXjvb,.vbIt3d,.IuoSj,.B2VR9,.CJHX3e,.Jbxz5,.fPG77c,.wyccme,.Ww4FFb,.ouy7Mc,.qR29te,[role='region'][aria-label='Ads'],[role='region'][aria-label='Shopping ads'],[aria-label='Sponsored'],[aria-label='Sponsored result'],[aria-label='Ads'],.sh-dgr__content,.sh-dlr__content,.pla-result,.pla-result-ads,.xpdopen,.M8OgIe,.dWz1gf,[data-entity='shopping-ads'],[data-entity='pla'],[data-entity='shopping-search-results'],[data-entity='shopping-result'],[data-text-ad='1'],[data-text-ad],[data-ad='1'],[data-hveid][data-text-ad],[aria-label='Ask and explore anything with the Google app'] {display:none!important;}" +
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
      ".B2VR9",
      ".CJHX3e",
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
      ".pla-result-ads",
      ".Jbxz5",
      ".fPG77c",
      ".wyccme",
      ".Ww4FFb",
      ".ouy7Mc",
      ".qR29te",
      ".xpdopen",
      ".M8OgIe",
      ".dWz1gf",
      "[class*='B2VR9']",
      "[class*='CJHX3e']",
      "[data-text-ad='1']",
      "[data-text-ad]",
      "[data-ad='1']",
      "[data-hveid][data-text-ad]"
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

  function getNodeText(node) {
    if (!node) { return ""; }
    var text = node.textContent || "";
    if (node.getAttribute) {
      var aria = node.getAttribute("aria-label");
      var dataText = node.getAttribute("data-text");
      var dataTextAd = node.getAttribute("data-text-ad");
      var dataHveid = node.getAttribute("data-hveid");
      var dataAd = node.getAttribute("data-ad");
      if (aria) {
        text += " " + aria;
      }
      if (dataText) {
        text += " " + dataText;
      }
      if (dataTextAd) {
        text += " " + dataTextAd;
      }
      if (dataHveid) {
        text += " " + dataHveid;
      }
      if (dataAd) {
        text += " " + dataAd;
      }
    }
    return normalizeText(text);
  }

  function isAdvertText(text) {
    if (!text) { return false; }
    if (/\b(sponsored|ads?|advertisement|shopping\s+ads?|廣告|ad results?)\b/.test(text)) {
      return true;
    }
    if (text.indexOf("ask and explore anything with the google app") >= 0) {
      return true;
    }
    if (text.indexOf("shopping\u2011ads") >= 0 || text.indexOf("shopping ads") >= 0) {
      return true;
    }
    return false;
  }

  function isSponsoredClass(node) {
    var cls = (node.className && node.className.toString()) || "";
    return /\b(qGXjvb|vbIt3d|IuoSj|B2VR9|CJHX3e|M8OgIe|xpdopen|dWz1gf|Jbxz5|fPG77c|wyccme|Ww4FFb|ouy7Mc|qR29te)\b/i.test(cls);
  }

  function isSponsoredLabelText(text, isShoppingPage) {
    return isAdvertText(text);
  }

  function findGoogleAdContainer(node) {
    var p = node;
    for (var i = 0; i < 30 && p; i++) {
      if (p === document || p === null) { return null; }
      var id = p.id || "";
      var role = (p.getAttribute && p.getAttribute("role")) || "";
      var aria = (p.getAttribute && p.getAttribute("aria-label")) || "";
      var ariaLower = aria.toLowerCase();
      var cls = (p.className && p.className.toString()) || "";
      var jsname = (p.getAttribute && p.getAttribute("jsname")) || "";
      var dataText = (p.getAttribute && p.getAttribute("data-text")) || "";
      var dataTextAd = (p.getAttribute && p.getAttribute("data-text-ad")) || "";
      var dataHveid = (p.getAttribute && p.getAttribute("data-hveid")) || "";
      var dataAd = (p.getAttribute && p.getAttribute("data-ad")) || "";
      var dataEntity = (p.getAttribute && p.getAttribute("data-entity")) || "";
      if (id === "tads" || id === "tadsb") {
        return p;
      }
      if (role === "region" && (aria === "Ads" || aria === "Shopping ads")) {
        return p;
      }
      if (isSponsoredClass(p)) {
        return p;
      }
      if (dataTextAd === "1" || dataAd === "1") {
        return p;
      }
      if (dataEntity === "shopping-ads" || dataEntity === "pla" || dataEntity === "shopping-search-results" || dataEntity === "shopping-result") {
        return p;
      }
      if (ariaLower === "sponsored" || ariaLower === "sponsored result" || ariaLower === "shopping ads" || ariaLower === "ads") {
        return p;
      }
      if (dataText && dataText.toLowerCase().indexOf("sponsored") >= 0) {
        return p;
      }
      if (dataTextAd && dataHveid) {
        return p;
      }
      if (jsname === "tY2w9d" || jsname === "ix0Hvc") {
        return p;
      }

      if ((p.id && p.id.length > 4) && /^tadsb?$/i.test(p.id)) {
        return p;
      }

      p = p.parentElement;
    }

    var fallback = node;
    for (var j = 0; j < 15 && fallback; j++) {
      var cls = (fallback.className && fallback.className.toString()) || "";
      if (cls && /\b(sponsored|ad|shopping|promo|promo-item|result)\b/i.test(cls)) {
        return fallback;
      }
      fallback = fallback.parentElement;
    }

    return null;
  }

  function hideFromNodeText(root, isShoppingPage) {
    var targets = root.querySelectorAll("span,div,p,a,h1,h2,h3,h4,h5,li,button,[role='heading'],[role='listitem'],[aria-label],[data-text],[data-text-ad],[data-ad],[data-hveid]");
    for (var i = 0; i < targets.length; i++) {
      var n = targets[i];
      if (n.getAttribute && n.getAttribute("data-text-ad") === "1") {
        var direct = findGoogleAdContainer(n) || n;
        direct.style.display = "none";
        continue;
      }
      var t = getNodeText(n);
      if (!isSponsoredLabelText(t, isShoppingPage)) { continue; }
      if (isSponsoredClass(n)) {
        n.style.display = "none";
        continue;
      }

      if (isAdvertText(t)) {
        var fallbackRoot = findGoogleAdContainer(n);
        if (!fallbackRoot) {
          fallbackRoot = n;
          for (var j = 0; j < 8 && fallbackRoot && fallbackRoot.parentElement; j++) {
            var maybeContainer = fallbackRoot.parentElement;
            if (maybeContainer && (isSponsoredClass(maybeContainer) || /\b(B2VR9|CJHX3e|qGXjvb|pla-result|sh-dg|xpdopen|dWz1gf|Ww4FFb|ouy7Mc|qR29te|fPG77c|wyccme|Jbxz5)\b/i.test((maybeContainer.className && maybeContainer.className.toString()) || ""))) {
              fallbackRoot = maybeContainer;
              break;
            }
            if ((maybeContainer.getAttribute && (maybeContainer.getAttribute("data-text-ad") === "1" || maybeContainer.getAttribute("data-ad") === "1" || maybeContainer.getAttribute("role") === "region" || maybeContainer.id === "tads" || maybeContainer.id === "tadsb")) {
              fallbackRoot = maybeContainer;
              break;
            }
            fallbackRoot = maybeContainer;
          }
        }
        fallbackRoot.style.display = "none";
        continue;
      }

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
