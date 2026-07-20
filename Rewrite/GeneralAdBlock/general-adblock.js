/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

const requestBody = $response.body || "";
const isGoogleSearch = $request.url.includes("www.google.com/search");

const AD_TEXT_MARKER = "Ask and explore anything with the Google app";
const AD_BLOCK_SELECTORS = [
  "#tads",
  "#tadsb",
  '[role="region"][aria-label="Ads"]',
  '[aria-label="Sponsored result"]',
  '[aria-label="Ads"]',
  '[aria-label="Sponsored"]',
  '[class*="B2VR9"]',
  '[class*="CJHX3e"]',
  '[aria-label*="Google app"]',
  "promo-throttler",
  "[data-promo-id]",
  "[data-promoid]",
  '[jsname="eJoPub"]',
  '[data-text="Ask and explore anything with the Google app"]',
];

const AD_REQUEST_PATTERNS = [
  "ogads-pa.clients6.google.com",
  "/$rpc/google.internal.onegoogle.asyncdata.v1.AsyncDataService/GetAsyncData",
  "pagead/1p-conversion",
  "googleadservices.com/pagead/conversion",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
  "doubleclick.net",
  "googlesyndication.com",
];

const AD_STYLE_TEXT =
  "#tads,#tadsb,[role='region'][aria-label='Ads'],[aria-label='Sponsored result'],[aria-label='Ads'],[aria-label='Sponsored'],a[href*='pagead'],img[src*='pagead'],img[src*='googlesyndication'],script[src*='adservice'],script[src*='pagead'],iframe[src*='pagead']{display:none!important};";

function runGoogleResponsePatcher() {
  var body = requestBody;

  if (body.indexOf(AD_TEXT_MARKER) >= 0) {
    body = body
      .replace(/class="B2VR9 CJHX3e"/g, 'class="B2VR9 CJHX3e" style="display:none!important"')
      .replace(/class=\\"B2VR9 CJHX3e\\"/g, 'class=\\"B2VR9 CJHX3e\\" style=\\"display:none!important\\"');
  }

  function injectScript() {
  return `
<script>
(function() {
  "use strict";
  var AD_BLOCK_SELECTORS = ${JSON.stringify(AD_BLOCK_SELECTORS)};
  var AD_REQUEST_PATTERNS = ${JSON.stringify(AD_REQUEST_PATTERNS)};
  var AD_STYLE_TEXT = ${JSON.stringify(AD_STYLE_TEXT)};

  function shouldBlockAdRequest(url) {
    if (!url) {
      return false;
    }
    for (var i = 0; i < AD_REQUEST_PATTERNS.length; i++) {
      if (url.indexOf(AD_REQUEST_PATTERNS[i]) >= 0) {
        return true;
      }
    }
    return false;
  }

  function injectStyle() {
    if (document.getElementById("__googleAdBlockerCSS")) {
      return;
    }
    var s = document.createElement("style");
    s.id = "__googleAdBlockerCSS";
    s.textContent = AD_STYLE_TEXT;
    if (document.head) {
      document.head.appendChild(s);
    }
  }

  function hideBySelector(root, selector) {
    var nodes = root.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].style.display = "none";
    }
  }

  function closest(node, predicate, maxDepth) {
    var current = node;
    var depth = 0;
    while (current && depth++ <= maxDepth) {
      if (predicate(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function hideGoogleInviteNodes(root) {
    var nodes = root.querySelectorAll("span,div,li,a,p,h2,h3,section,article,button,promo-throttler,[data-promo-id],[data-promoid]");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var text = (n.textContent || "").trim().toLowerCase();
      var cls = (n.getAttribute && n.getAttribute("class")) || "";
      var hasPromoAttr =
        n.getAttribute &&
        (
          n.getAttribute("data-promo-id") ||
          n.getAttribute("data-promoid") ||
          n.getAttribute("jsname") === "SgxdIe" ||
          n.getAttribute("jsname") === "eJoPub" ||
          cls.indexOf("B2VR9") >= 0 ||
          cls.indexOf("CJHX3e") >= 0
        );
      if (!hasPromoAttr && text.indexOf("ask and explore anything") < 0 && text.indexOf("ask and explore") < 0) {
        continue;
      }
      var wrapper = closest(n, function(node) {
        return (
          node.id === "rso" ||
          (node.getAttribute && (node.getAttribute("role") === "region" || node.getAttribute("role") === "complementary"))
        );
      }, 10);
      if (wrapper) {
        wrapper.style.display = "none";
      }
    }
  }

  function hideSponsoredNodes(root) {
    for (var i = 0; i < AD_BLOCK_SELECTORS.length; i++) {
      hideBySelector(root, AD_BLOCK_SELECTORS[i]);
    }
    var nodes = root.querySelectorAll("span,div,li,a");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var cls = (n.getAttribute && n.getAttribute("class")) ? n.getAttribute("class") : "";
      var text = (n.textContent || "").trim().toLowerCase();
      var classMatch = cls.indexOf("B2VR9") >= 0 || cls.indexOf("CJHX3e") >= 0;
      var textMatch = text === "sponsored result" || text === "sponsored" || text.indexOf("sponsored ") === 0;
      if (!classMatch && !textMatch) {
        continue;
      }
      var wrapper = closest(n, function(node) {
        return node.id === "tads" || (node.getAttribute && node.getAttribute("role") === "region");
      }, 8);
      if (wrapper) {
        wrapper.style.display = "none";
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
        var requestUrl = "";
        if (typeof input === "string") {
          requestUrl = input;
        } else if (input && input.url) {
          requestUrl = input.url;
        }
        if (shouldBlockAdRequest(requestUrl)) {
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
      XMLHttpRequest.prototype.send = function(data) {
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

  function refresh() {
    hideSponsoredNodes(document);
    hideGoogleInviteNodes(document);
  }

  function applyRules() {
    injectStyle();
    refresh();
    patchNetwork();
  }

  applyRules();
  var observer = new MutationObserver(function() {
    refresh();
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
</script>`;
  }

  if (body.indexOf("</head>") >= 0) {
    body = body.replace("</head>", injectScript() + "</head>");
  } else if (body.indexOf("</body>") >= 0) {
    body = body.replace("</body>", injectScript() + "</body>");
  }

  $done({ body });
}

if (isGoogleSearch) {
  runGoogleResponsePatcher();
} else {
  $done({ body: requestBody });
}
