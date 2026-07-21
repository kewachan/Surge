/**
 * Manhuashe AdBlock
 * Unified module: single purpose per app/site.
 */

let body = $response.body || "";
const url = $request.url || "";

const isAdEndpoint =
  /manhuashe\.com\/v\d\/(?:ads|topicbytype|chapterendrecommend|homenav|startupactivity)/i.test(url);

const adKeyReg = /(?:^|[._-])(ad|ads|banner|splash|startup|startupactivity|homenav|topicbytype|recommend|interstitial)(?:[A-Za-z0-9_]{0,40})?(?:[._-].*)?$/i;

function scrubJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const v = scrubJsonValue(value[i]);
      if (v !== null && v !== undefined) {
        out.push(v);
      }
    }
    return out;
  }

  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      if (adKeyReg.test(k)) {
        continue;
      }
      out[k] = scrubJsonValue(v);
    }
    return out;
  }

  return value;
}

function stripAdNodesForHtml(text) {
  const style = `<style id="__manhuasheAdHideCSS">`;
  if (!text.includes("<head>") || !text.includes("</head>")) {
    return text;
  }
  const css = `${style}.ad-wrap,.ad,.banner,.splash,[data-ad],[data-adv],[data-banner],.ads,.ad-banner,.ad-item,.ad-slot{display:none!important;}
  .mhs-ad,.mhs-banner,.promotion,.recommend-splash{display:none!important;}</style>`;
  const script = `<script>
(function(){
  function hide() {
    document.querySelectorAll(".ad-wrap,.ad,.banner,.splash,[data-ad],[data-adv],[data-banner],.ads,.ad-banner,.ad-item,.ad-slot,.mhs-ad,.mhs-banner,.promotion,.recommend-splash")
      .forEach(function(n){ n.style.display = "none"; });
  }
  hide();
  if (typeof MutationObserver !== "undefined") {
    var mo = new MutationObserver(function(){ hide(); });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
})();</script>`;

  return text.replace("</head>", `${css}${script}</head>`);
}

if (!isAdEndpoint) {
  $done({ body });
}

const t = body.trim();
if (t.startsWith("{") || t.startsWith("[")) {
  try {
    const obj = JSON.parse(body);
    const cleaned = scrubJsonValue(obj);
    if (cleaned !== undefined) {
      body = JSON.stringify(cleaned);
    }
  } catch (err) {
    // fallback: keep body unchanged
  }
} else if (/<html|<body|<script|<style/i.test(body)) {
  body = stripAdNodesForHtml(body);
}

$done({ body });
