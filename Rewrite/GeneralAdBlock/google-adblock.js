/**
 * Google AdBlock (Simplified)
 * Merge key rules from Limbo: remove Google ads/ sponsored cards.
 */

let body = $response.body || "";
const url = $request.url || "";
const isGoogleSearch = /https?:\/\/(www\.)?google\.[^/]+\/search/.test(url);

if (isGoogleSearch && body) {
  const inject = `
<script>
(function() {
  if (window.__kewaGoogleAdBlock__) {
    return;
  }
  window.__kewaGoogleAdBlock__ = true;

  const HOST_RULES = [
    "pagead.", "googlesyndication", "doubleclick.net", "adservice", "googleads.", "adservice.google",
    "/$rpc/google.internal.onegoogle.asyncdata.v1.AsyncDataService/GetAsyncData"
  ];
  const AD_TEXT = /(sponsored|ads?|advertisement|advertised|promoted|shopping\\s*ads?|shopping\\s*results?|ad\\s*results?|\\u5ee3\\u544a|\\u5ee3\\u544a\\u5167\\u5bb9|\\u8d5e\\u52a9|\\u8d5e\\u52a9\\u5167\\u5bb9)/i;
  const BAD_CLASS = /\\b(B2VR9|CJHX3e|qGXjvb|vbIt3d|IuoSj|Jbxz5|fPG77c|wyccme|Ww4FFb|ouy7Mc|qR29te|QzEO9c|CqmPRe|xpdopen|M8OgIe|dWz1gf|jnyxRd|XDZKBc|tvcap)\\b/i;

  const HIDE_SEL = [
    "#tvcap", "#tads", "#tadsb", "[data-text-ad='1']", "[data-text-ad]", "[data-ad='1']",
    "#botstuff", "[data-entity='shopping-ads']", "[data-entity='pla']", "[data-entity='shopping-search-results']", "[data-entity='shopping-result']",
    "[data-hveid][data-text-ad]", "[aria-label='Ads']", "[aria-label='Shopping ads']", "[aria-label='Sponsored']", "[aria-label='Sponsored result']", "[role='region'][aria-label='Ads']", "[role='region'][aria-label='Shopping ads']",
    "a[href*='pagead'], img[src*='pagead'], img[src*='googlesyndication'], iframe[src*='pagead'], iframe[src*='googlesyndication']",
    "script[src*='pagead'], script[src*='adservice'], script[src*='googlesyndication'], script[src*='doubleclick']",
    ".qGXjvb", ".vbIt3d", ".IuoSj", ".B2VR9", ".CJHX3e", ".Jbxz5", ".fPG77c", ".wyccme", ".Ww4FFb", ".ouy7Mc", ".qR29te",
    ".QzEO9c", ".CqmPRe", ".mnr-c", ".xpdopen", ".M8OgIe", ".dWz1gf", ".sh-dgr__content", ".sh-dlr__content", ".pla-result", ".pla-result-ads",
    ".jnyxRd.TpRPV", "div.XDZKBc", "[jsname='ix0Hvc']", "[jsname='tY2w9d']"
  ];

  function addCSS() {
    if (document.getElementById("__kewaGoogleAdBlockCSS")) {
      return;
    }
    const s = document.createElement("style");
    s.id = "__kewaGoogleAdBlockCSS";
    s.textContent = HIDE_SEL.join(", ") + "{display:none !important;}";
    (document.head || document.documentElement).appendChild(s);
  }

  function hideNode(node) {
    if (!node || !node.style) {
      return;
    }
    node.style.setProperty("display", "none", "important");
    node.style.setProperty("opacity", "0", "important");
    node.style.setProperty("visibility", "hidden", "important");
  }

  function textOf(node) {
    if (!node) return "";
    return (node.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
  }

  function shouldBlockURL(u) {
    if (!u) return false;
    const href = (u + "").toLowerCase();
    return HOST_RULES.some(function(key){ return href.indexOf(key) >= 0; });
  }

  function parentContainer(node, limit) {
    let p = node;
    for (let i = 0; i < (limit || 24) && p; i++) {
      if (!p || p === document.body || p === document.documentElement) {
        break;
      }
      if (p === document.documentElement) {
        break;
      }
      const cls = (p.className || "").toString();
      const id = p.id || "";
      const role = p.getAttribute ? (p.getAttribute("role") || "") : "";
      const dv = p.getAttribute ? (p.getAttribute("data-ved") || "") : "";
      const hveid = p.getAttribute ? (p.getAttribute("data-hveid") || "") : "";
      const resultIndex = p.getAttribute ? (p.getAttribute("data-result-index") || "") : "";
      const dataTextAd = p.getAttribute ? (p.getAttribute("data-text-ad") || "") : "";
      const dataEntity = p.getAttribute ? (p.getAttribute("data-entity") || "") : "";
      const jsname = p.getAttribute ? (p.getAttribute("jsname") || "") : "";

      if (id === "tads" || id === "tadsb" || id === "tvcap" || id === "botstuff") return p;
      if (role === "region" && (p.getAttribute("aria-label") || "").match(/^(Ads|Shopping ads|Sponsored|Sponsored result)$/i)) return p;
      if (dataTextAd === "1" || dataEntity || resultIndex || dv || hveid) return p;
      if (jsname === "ix0Hvc" || jsname === "tY2w9d") return p;
      if (id && /^rso\\d*$/i.test(id)) return p;
      if (BAD_CLASS.test(cls)) return p;
      if (/\\b(r|g|mnr-c|xpd|pla-result|sh-dgr__content|Ww4FFb|qGXjvb|vbIt3d|IuoSj|QzEO9c|CqmPRe|Jbxz5|xpdopen)\\b/i.test(cls)) return p;
      p = p.parentElement;
    }
    return node;
  }

  function hideAskAndExplore() {
    if (document.body && /Ask and explore anything with the Google app/.test(document.body.innerText || "")) {
      document.querySelectorAll(".B2VR9, .CJHX3e, .B2VR9.CJHX3e, [class*='B2VR9'], [class*='CJHX3e']").forEach(function(n){
        if (n && n.className && /B2VR9/.test((n.className || "").toString()) && /CJHX3e/.test((n.className || "").toString())) {
          hideNode(n);
        }
      });
    }
  }

  function hideByRules() {
    addCSS();
    hideAskAndExplore();

    const nodes = document.querySelectorAll("[data-text-ad='1'], [data-text-ad], [data-ad='1'], [aria-label='Sponsored'], [aria-label='Sponsored result'], [aria-label='Ads'], [aria-label='Shopping ads'], [role='region'][aria-label='Ads'], [role='region'][aria-label='Shopping ads'], .B2VR9, .CJHX3e, .QzEO9c, .CqmPRe, [jsname='ix0Hvc'], [jsname='tY2w9d'], .mnr-c, .xpdopen, .dWz1gf, .M8OgIe");
    nodes.forEach(function(node) {
      hideNode(parentContainer(node, 40));
    });

    document.querySelectorAll("div[data-hveid], div[data-result-index], li[role='listitem'], div[class*='g'], div[class*='mnr-c'], div[role='listitem'], div[class*='xpd'], div[data-sokoban-grid]").forEach(function(card) {
      const text = textOf(card);
      const anchor = card.querySelector("a[href]");
      const host = anchor && anchor.hostname ? anchor.hostname : "";
      const cls = (card.className || "").toString();
      if (AD_TEXT.test(text) || BAD_CLASS.test(cls)) {
        hideNode(parentContainer(card, 26));
        return;
      }
      if (host && shouldBlockURL(host)) {
        hideNode(parentContainer(card, 26));
      }
      card.querySelectorAll("a[href], img[src], iframe[src]").forEach(function(n) {
        if (shouldBlockURL(n.getAttribute("href") || n.getAttribute("src") || "")) {
          hideNode(parentContainer(card, 26));
        }
      });
    });
  }

  function patchRequestBlock() {
    if (window.__kewaGoogleAdBlockPatched__) {
      return;
    }
    window.__kewaGoogleAdBlockPatched__ = true;

    const oldFetch = window.fetch;
    if (typeof oldFetch === "function") {
      window.fetch = function(input, init) {
        const u = typeof input === "string" ? input : (input && input.url ? input.url : "");
        if (shouldBlockURL(u)) {
          return Promise.resolve(new Response("", { status: 204, statusText: "Blocked by Kewa Google adblock" }));
        }
        return oldFetch.call(this, input, init);
      };
    }

    const oldOpen = XMLHttpRequest.prototype.open;
    const oldSend = XMLHttpRequest.prototype.send;
    if (oldOpen && oldSend) {
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__kewaAdUrl = url || "";
        return oldOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (shouldBlockURL(this.__kewaAdUrl)) {
          this.abort();
          return;
        }
        return oldSend.apply(this, arguments);
      };
    }
  }

  hideByRules();
  patchRequestBlock();
  const mo = new MutationObserver(function() {
    hideByRules();
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
</script>`;

  if (body.includes("</head>")) {
    body = body.replace("</head>", inject + "</head>");
  } else if (body.includes("</body>")) {
    body = body.replace("</body>", inject + "</body>");
  } else {
    body += inject;
  }
}

$done({ body });
