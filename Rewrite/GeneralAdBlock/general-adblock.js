/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

let body = $response.body || "";
const isGoogleSearch = $request.url.includes("www.google.com/search");

// Google Search: hide ad blocks that cannot be blocked safely by simple rules.
if (isGoogleSearch) {
  const inject = `
<script>
(function() {
  function injectStyle() {
    if (document.getElementById("__googleAdBlockerCSS")) {
      return;
    }
    var s = document.createElement("style");
    s.id = "__googleAdBlockerCSS";
    s.textContent =
      "#tads,#tadsb,[role='region'][aria-label='Ads'],[aria-label='Sponsored result'],[aria-label='Ads'],[aria-label='Sponsored'],a[href*='pagead'],img[src*='pagead'],img[src*='googlesyndication'],script[src*='adservice'],script[src*='pagead'],iframe[src*='pagead']{display:none!important};";
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

  function hideAdNodes(root) {
    var selectors = [
      "#tads",
      "#tadsb",
      '[role="region"][aria-label="Ads"]',
      '[aria-label="Sponsored result"]',
      '[aria-label="Ads"]',
      '[aria-label="Sponsored"]',
      '[class*="B2VR9"]',
      '[class*="CJHX3e"]',
      '[aria-label*="Google app"]',
      '[data-text="Ask and explore anything with the Google app"]',
    ];
    selectors.forEach(function(sel) {
      root.querySelectorAll(sel).forEach(function(n){ n.style.display = "none"; });
    });
  }

  function hideGoogleAppInvite(root) {
    var blocks = root.querySelectorAll("span,div,li,a,p,h2,h3,section,article,button");
    for (var i = 0; i < blocks.length; i++) {
      var n = blocks[i];
      var t = (n.textContent || "").trim().toLowerCase();
      if (!t) { continue; }
      if (t.indexOf("ask and explore anything") >= 0 || t.indexOf("ask and explore") >= 0) {
        var p = n;
        for (var j = 0; j < 10 && p; j++) {
          if (p.id === "rso" || (p.getAttribute && (p.getAttribute("role") === "region" || p.getAttribute("role") === "complementary"))) {
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

  function hideSponsoredNodes(root) {
    hideAdNodes(root);
    var blocks = root.querySelectorAll("span,div,li,a");
    for (var i = 0; i < blocks.length; i++) {
      var n = blocks[i];
      var t = (n.textContent || "").trim().toLowerCase();
      var cls = (n.getAttribute && n.getAttribute("class")) ? n.getAttribute("class") : "";
      var isClassTarget = cls.indexOf("B2VR9") >= 0 || cls.indexOf("CJHX3e") >= 0;
      if (!t) { continue; }
      var isSponsored = isClassTarget || t === "sponsored result" || t === "sponsored" || t.startsWith("sponsored ");
      if (isSponsored) {
        var p = n.parentElement;
        for (var j = 0; j < 8 && p; j++) {
          if (p.id === "tads" || (p.getAttribute && p.getAttribute("role") === "region")) {
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
    injectStyle();
    hideSponsoredNodes(document);
    hideGoogleAppInvite(document);
    patchNetwork();
  }

  onReady();
  var mo = new MutationObserver(function(){
    hideSponsoredNodes(document);
    hideGoogleAppInvite(document);
  });
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
