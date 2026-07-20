/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

let body = $response.body || "";

// Google Search: hide the "Ask and explore anything with the Google app" promo.
if ($request.url.includes("www.google.com/search")) {
  const inject = `
<script>
(function() {
  function hideSponsoredNodes(root) {
    var selectors = [
      "#tads",
      "#tadsb",
      '[role="region"][aria-label="Ads"]',
      '[aria-label="Sponsored result"]'
    ];
    selectors.forEach(function(sel) {
      root.querySelectorAll(sel).forEach(function(n){ n.style.display = "none"; });
    });

    var blocks = root.querySelectorAll("span,div,li,a");
    for (var i = 0; i < blocks.length; i++) {
      var n = blocks[i];
      var t = (n.textContent || "").trim().toLowerCase();
      if (!t) { continue; }
      if (t === "sponsored result" || t === "sponsored" || t.startsWith("sponsored ")) {
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

  function onReady() {
    hideSponsoredNodes(document);
  }

  onReady();
  var mo = new MutationObserver(function(){ hideSponsoredNodes(document); });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
</script>`;

  if (body.includes("</body>")) {
    body = body.replace("</body>", inject + "</body>");
  }
}

$done({ body });
