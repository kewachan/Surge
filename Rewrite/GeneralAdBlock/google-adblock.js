/**
 * Google AdBlock for Surge
 *
 * Simple DOM-based sponsored-result blocker.
 * - Remove known promo blocks from HTML body when possible.
 * - Inject runtime script to hide sponsored result nodes by text + ancestor heuristics.
 */

var body = $response.body || "";
var isGoogleSearch = /https?:\/\/(www\.)?google\.[^/]+\/search/i.test($request.url);

if (!isGoogleSearch) {
  $done({ body: body });
  return;
}

if (body.includes("Ask and explore anything with the Google app")) {
  body = body
    .replaceAll('class="B2VR9 CJHX3e"', 'class="B2VR9 CJHX3e" style="display:none!important"')
    .replaceAll('class="CJHX3e B2VR9"', 'class="CJHX3e B2VR9" style="display:none!important"')
    .replaceAll('class="B2VR9"', 'class="B2VR9" style="display:none!important"');
}

var inject = `
<script>
(function() {
  function addBaseStyle() {
    if (document.getElementById('__ggAdsCSS')) return;
    var s = document.createElement('style');
    s.id = '__ggAdsCSS';
    s.textContent = [
      '#tvcap,#tads,#tadsb,[aria-label="Sponsored"],[aria-label="Sponsored result"],[aria-label="Ads"],[aria-label="Shopping ads"],',
      '[role="region"][aria-label="Ads"],[role="region"][aria-label="Shopping ads"],[data-entity="shopping-ads"],',
      '[data-entity="pla"],[data-entity="shopping-result"],[data-text-ad="1"],[data-ad="1"],[class*="B2VR9"],[class*="CJHX3e"],[class*="M8OgIe"],[class*="dWz1gf"],',
      '[jsname="ix0Hvc"],[jsname="tY2w9d"] { display: none !important; opacity: 0 !important; }'
    ].join('');
    document.documentElement.appendChild(s);
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isSponsoredLabel(text) {
    if (!text) return false;
    var t = normalizeText(text);
    return /^((sponsored|ad|ads|廣告|贊助|贊助內容|shopping\s*ads?|promoted|promotion))$/.test(t) ||
      /^sponsored\s*result(s)?$/.test(t) ||
      /\b(sponsored|shopping\s*ads?)\b/.test(t);
  }

  function getText(node) {
    if (!node) return '';
    var text = node.textContent || '';
    if (node.getAttribute) {
      var aria = node.getAttribute('aria-label');
      var dataText = node.getAttribute('data-text');
      var dataTextAd = node.getAttribute('data-text-ad');
      var dataAd = node.getAttribute('data-ad');
      var title = node.getAttribute('title');
      var alt = node.getAttribute('alt');
      if (aria) text += ' ' + aria;
      if (dataText) text += ' ' + dataText;
      if (dataTextAd) text += ' ' + dataTextAd;
      if (dataAd) text += ' ' + dataAd;
      if (title) text += ' ' + title;
      if (alt) text += ' ' + alt;
    }
    return text;
  }

  function hideNode(node) {
    if (!node || !node.style) return;
    node.style.setProperty('display', 'none', 'important');
    node.style.setProperty('opacity', '0', 'important');
  }

  function looksLikeSponsorContainer(node) {
    if (!node || !node.getAttribute) return false;
    var cls = (node.className && node.className.toString()) || '';
    return /\b(B2VR9|CJHX3e|M8OgIe|dWz1gf|qGXjvb|vbIt3d|IuoSj|sh-dgr|pla-result|xpdopen|shopping-result)\b/i.test(cls)
      || /^(tvcap|tads|tadsb)$/.test((node.id || '').toLowerCase());
  }

  function isResultContainer(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toUpperCase();
    return tag === 'LI' || tag === 'ARTICLE' || tag === 'SECTION' || tag === 'DIV';
  }

  function nearestContainer(node) {
    var p = node;
    for (var i = 0; i < 30 && p && p !== document && p !== document.body; i++) {
      if (!p.getAttribute) break;

      var dataIndex = p.getAttribute('data-result-index');
      var dataHveid = p.getAttribute('data-hveid');
      var dataVed = p.getAttribute('data-ved');
      var dataTextAd = p.getAttribute('data-text-ad');
      var dataAd = p.getAttribute('data-ad');
      var dataEntity = p.getAttribute('data-entity');
      var role = p.getAttribute('role') || '';
      var jsname = p.getAttribute('jsname') || '';
      var id = (p.id || '').toLowerCase();
      var cls = (p.className && p.className.toString()) || '';

      if (id === 'tvcap' || id === 'tads' || id === 'tadsb') return p;
      if (dataIndex || dataHveid || dataVed || dataTextAd === '1' || dataAd === '1' || dataEntity) return p;
      if (role === 'listitem' || role === 'region' || role === 'presentation') return p;
      if (jsname === 'ix0Hvc' || jsname === 'tY2w9d') return p;
      if (looksLikeSponsorContainer(p)) return p;
      if (/\b(r|g|xpd|kCrYT|MjjYud|xpdopen|pla-result|sh-dgr|search|result|mnr-c|srg)\b/i.test(cls)) return p;

      if (isResultContainer(p)) return p;

      p = p.parentElement;
    }
    return node;
  }

  function removeFromText(root) {
    var nodes = root.querySelectorAll('span,div,p,a,li,section,article,h1,h2,h3,h4,h5,h6,[role="heading"],[role="listitem"],[aria-label],[data-text],[data-text-ad],[data-entity],[data-hveid],[data-ved]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = normalizeText(getText(n));
      if (!t) continue;
      if (!isSponsoredLabel(t)) continue;

      var container = nearestContainer(n);
      if (container && container !== n) {
        hideNode(container);
      } else {
        hideNode(n);
      }
    }
  }

  function run() {
    addBaseStyle();
    removeFromText(document);
  }

  function runOnceWhenReady() {
    if (document.body) {
      run();
    } else {
      setTimeout(runOnceWhenReady, 80);
      return;
    }

    var lastRun = 0;
    var observer = new MutationObserver(function() {
      var now = Date.now();
      if (now - lastRun < 180) return;
      lastRun = now;
      run();
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: false, characterData: false });
  }

  runOnceWhenReady();
})();
</script>`;

if (/^<!doctype html>/i.test(body) || /<html[\s>]/i.test(body)) {
  if (body.toLowerCase().indexOf('</body>') !== -1) {
    body = body.replace('</body>', inject + '</body>');
  } else {
    body = body + inject;
  }
}

$done({ body: body });
