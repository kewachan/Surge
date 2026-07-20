/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

let body = $response.body || "";
const isGoogleSearch = $request.url.includes("www.google.com/search");
const isGoogleShopping = $request.url.includes("www.google.com/shopping") || $request.url.includes("tbm=shop");
const targetURL = isGoogleSearch || isGoogleShopping;

// Google Search & Shopping: hide ad blocks that cannot be blocked by simple rules.
if (targetURL) {
  const inject = `
<script>
(function() {
  function hideBySelector(root, isShoppingPage) {
    var selectors = [
      "#tads",
      "#tadsb",
      '[role="region"][aria-label="Ads"]',
      '[aria-label="Sponsored result"]',
      '[aria-label="Ads"]',
      '[aria-label="Shopping ads"]',
      '[aria-label="Sponsored"]',
      "g-section-with-header[aria-label][style*='block']"
    ];
    if (isShoppingPage) {
      selectors = selectors.concat([
        ".sh-dgr__content",
        ".sh-dlr__content",
        ".sh-sf",
        ".pla-result",
        "[data-entity='shopping-search-results'] [role='listitem']",
        "[data-entity='shopping-result']",
        "[data-entity='shopping-search-results']",
        "[data-entity='shopping-ads']",
        "[data-entity='shopping-results'] [role='listitem']",
        "[data-entity='pla']",
        ".xpdopen"
      ]);
    }
    selectors.forEach(function(sel) {
      root.querySelectorAll(sel).forEach(function(n){ n.style.display = "none"; });
    });
  }

  function hideSponsoredByContent(root, isShoppingPage) {
    var blocks = root.querySelectorAll("span,div,li,a");
    for (var i = 0; i < blocks.length; i++) {
      var n = blocks[i];
      var t = (n.textContent || "").trim().toLowerCase();
      if (!t) { continue; }
      var href = (n.getAttribute && n.getAttribute("href")) ? (n.getAttribute("href") || "").toLowerCase() : "";
      if (href.indexOf("aclk") >= 0 || href.indexOf("adurl") >= 0 || href.indexOf("googleadservices") >= 0 || href.indexOf("doubleclick") >= 0 || href.indexOf("googlesyndication") >= 0) {
        var h = n;
        for (var hIter = 0; hIter < 6 && h; hIter++) {
          if (h.getAttribute && h.getAttribute("role") === "listitem") { break; }
          h = h.parentElement;
        }
        if (h) { h.style.display = "none"; }
      }

      var isSponsored = t === "sponsored result" || t === "sponsored" || t.startsWith("sponsored ");
      if (isShoppingPage && (t.indexOf("sponsored") >= 0 || t.indexOf("廣告") >= 0 || t.indexOf("advertisement") >= 0)) {
        isSponsored = true;
      }
      if (isShoppingPage && (t === "ad" || t === "ads" || t.indexOf(" ad ") >= 0 || t.indexOf(" ads ") >= 0)) {
        isSponsored = true;
      }
      if (isSponsored) {
        var p = n.parentElement;
        for (var j = 0; j < 12 && p; j++) {
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

  function onReady() {
    hideBySelector(document, ${isGoogleShopping});
    hideSponsoredByContent(document, ${isGoogleShopping});
  }

  onReady();
  var mo = new MutationObserver(function(){ 
    hideBySelector(document, ${isGoogleShopping});
    hideSponsoredByContent(document, ${isGoogleShopping});
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
</script>`;

  if (body.includes("</body>")) {
    body = body.replace("</body>", inject + "</body>");
  }
}

$done({ body });
