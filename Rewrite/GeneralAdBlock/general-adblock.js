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
  function hideSponsoredNodes(root, isShoppingPage) {
    var selectors = [
      "#tads",
      "#tadsb",
      '[role="region"][aria-label="Ads"]',
      '[aria-label="Sponsored result"]',
      '[aria-label="Ads"]'
    ];
    if (isShoppingPage) {
      selectors = selectors.concat([
        ".sh-dgr__content",
        ".sh-dlr__content",
        "[data-entity='shopping-search-results'] [role='listitem']",
        "[data-entity='shopping-result']"
      ]);
    }
    selectors.forEach(function(sel) {
      root.querySelectorAll(sel).forEach(function(n){ n.style.display = "none"; });
    });

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

  function onReady() {
    hideSponsoredNodes(document, ${isGoogleShopping});
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
