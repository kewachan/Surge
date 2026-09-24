/**
 * Facebook Web AdBlock for Surge — v1.0.5
 * Removes "Open app" calls to action from mobile Facebook pages while
 * preserving navigation, playback controls, and feed content. Also applies a
 * Facebook-toned iOS status bar, black feed separators, and transparent
 * post action and refresh controls in the standalone web app.
 */

(function () {
  "use strict";

  const MARKER = "data-surge-facebook-open-app";
  const STYLE_MARKER = "data-surge-facebook-dark-ui";

  function headerValue(headers, name) {
    const target = name.toLowerCase();
    const key = Object.keys(headers || {}).find(function (candidate) {
      return candidate.toLowerCase() === target;
    });
    return key ? String(headers[key]) : "";
  }

  function responseStatusCode() {
    const rawStatus = $response.statusCode || $response.status || "";
    const match = String(rawStatus).match(/\b(\d{3})\b/);
    return match ? parseInt(match[1], 10) : 200;
  }

  function scriptNonce(html) {
    const match = html.match(
      /<script\b[^>]*\bnonce\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i
    );
    return match ? (match[1] || match[2] || match[3] || "") : "";
  }

  function escapeAttribute(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function setMetaContent(html, name, content) {
    const tag = "<meta name=\"" + name + "\" content=\"" + content + "\">";
    let found = false;
    const updated = html.replace(/<meta\b[^>]*>/gi, function (meta) {
      const match = meta.match(
        /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
      );
      const value = match ? (match[1] || match[2] || match[3] || "") : "";

      if (value.toLowerCase() !== name.toLowerCase()) return meta;
      if (found) return "";

      found = true;
      return tag;
    });

    if (found) return updated;

    return updated.replace(/<head\b[^>]*>/i, function (head) {
      return head + tag;
    });
  }

  function injectedSource() {
    return `(function () {
  "use strict";

  var LABEL = "open app";
  var HIDDEN_ATTRIBUTE = "data-surge-open-app-hidden";
  var ACTION_ATTRIBUTE = "data-surge-facebook-action";
  var ACTION_PATTERN = /(?:^|[\\s_-])(?:like|unlike|comment|comments|share|refresh|reload)(?:\\b|[_-]|$)|^(?:讚好|取消讚好|赞|取消赞|留言|評論|评论|分享|重新整理|重新載入|重新加载|刷新)/i;
  var BUTTON_SELECTOR = "a,button,[role=\\"button\\"]";
  var SELECTOR = BUTTON_SELECTOR + ",[role=\\"progressbar\\"],[aria-label]";

  function normalizedText(element) {
    return String(element.textContent || "")
      .replace(/\\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function containingButton(node) {
    if (!node) return null;
    var element = node.nodeType === 1 ? node : node.parentElement;
    return element && element.closest ? element.closest(BUTTON_SELECTOR) : null;
  }

  function expandedTarget(element) {
    var target = element;

    for (var depth = 0; depth < 3; depth += 1) {
      var parent = target.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.matches("header,nav,main,[role=\\"navigation\\"]")) break;
      if (normalizedText(parent) !== LABEL) break;
      target = parent;
    }

    return target;
  }

  function hideButton(element) {
    if (!element || normalizedText(element) !== LABEL) return;

    var target = expandedTarget(element);
    if (target.getAttribute(HIDDEN_ATTRIBUTE) === "1") return;

    target.style.setProperty("display", "none", "important");
    target.setAttribute(HIDDEN_ATTRIBUTE, "1");
    target.setAttribute("aria-hidden", "true");
  }

  function actionLabel(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-sigil"),
      element.getAttribute("data-testid"),
      element.getAttribute("name"),
      element.textContent
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
  }

  function clearActionBubble(element) {
    if (!element) return;

    var target = element.matches(BUTTON_SELECTOR) ? element :
      (containingButton(element) || element);
    var label = actionLabel(element) + " " + actionLabel(target);
    if (!ACTION_PATTERN.test(label)) return;

    target.setAttribute(ACTION_ATTRIBUTE, "1");
    target.style.setProperty("background", "transparent", "important");
    target.style.setProperty("background-color", "transparent", "important");
    target.style.setProperty("border-color", "transparent", "important");
    target.style.setProperty("box-shadow", "none", "important");
  }

  function processButton(element) {
    hideButton(element);
    clearActionBubble(element);
  }

  function scan(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;

    if (root.nodeType === 1 && root.matches(SELECTOR)) processButton(root);

    var buttons = root.querySelectorAll(SELECTOR);
    for (var index = 0; index < buttons.length; index += 1) {
      processButton(buttons[index]);
    }
  }

  function start() {
    scan(document);

    new MutationObserver(function (records) {
      records.forEach(function (record) {
        processButton(containingButton(record.target));

        for (var index = 0; index < record.addedNodes.length; index += 1) {
          var node = record.addedNodes[index];
          if (node.nodeType === 1) {
            scan(node);
          } else {
            processButton(containingButton(node));
          }
        }
      });
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();`;
  }

  function injectedStyle() {
    return `html {
  background-color: #242526 !important;
}

html::before {
  content: "";
  position: fixed;
  z-index: 2147483647;
  top: 0;
  right: 0;
  left: 0;
  height: env(safe-area-inset-top);
  background-color: #242526 !important;
  pointer-events: none;
}

body,
#root,
#viewport,
#page,
#pagelet_feed_stream,
[role="feed"],
.storyStream {
  background-color: #000 !important;
}

hr,
[role="separator"],
._2v9s,
._o28 {
  background-color: #000 !important;
  border-color: #000 !important;
}

._52z5._7gxn,
._9mlm ._52z5,
._9mln ._52z5 {
  border-bottom-color: #000 !important;
}

.storyStream > .carded,
.storyStream > article > .carded,
.storyStream > div > .carded,
.groupChromeView.feedRevamp .carded {
  border-image: none !important;
  border-top-color: #000 !important;
  border-right-color: transparent !important;
  border-bottom-color: #000 !important;
  border-left-color: transparent !important;
}

[role="article"],
[role="article"] > div,
article,
article > div,
.storyStream > *,
[role="feed"] > *,
.storyStream .carded > div {
  border-top-color: #000 !important;
  border-bottom-color: #000 !important;
  outline-color: #000 !important;
  box-shadow: none !important;
}

[data-surge-facebook-action="1"],
[data-surge-facebook-action="1"]::before,
[data-surge-facebook-action="1"]::after,
[data-surge-facebook-action="1"] > * {
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}`;
  }

  const body = typeof $response.body === "string" ? $response.body : "";
  const contentType = headerValue($response.headers, "content-type");
  const isFacebookPage = /^https:\/\/m\.facebook\.com(?:\/|$)/i.test($request.url);
  const isHtml = /text\/html/i.test(contentType) ||
    /^\s*(?:<!doctype\s+html|<html\b)/i.test(body);

  if (!isFacebookPage || responseStatusCode() !== 200 || !isHtml || !body) {
    $done({});
    return;
  }

  let output = setMetaContent(body, "apple-mobile-web-app-capable", "yes");
  output = setMetaContent(output, "apple-mobile-web-app-status-bar-style", "black-translucent");
  output = setMetaContent(output, "theme-color", "#242526");

  const needsScript = output.indexOf(MARKER) === -1;
  const needsStyle = output.indexOf(STYLE_MARKER) === -1;

  if (needsScript || needsStyle) {
    const nonce = scriptNonce(output);
    let injection = "";

    if (nonce) {
      const nonceAttribute = " nonce=\"" + escapeAttribute(nonce) + "\"";

      if (needsStyle) {
        injection += "<style" + nonceAttribute + " " + STYLE_MARKER +
          "=\"1\">" + injectedStyle() + "</style>";
      }
      if (needsScript) {
        injection += "<script" + nonceAttribute + " " + MARKER +
          "=\"1\">" + injectedSource() + "</scr" + "ipt>";
      }
    } else {
      console.log("Facebook AdBlock: no CSP nonce found; page injection skipped");
    }

    if (injection && /<\/head\s*>/i.test(output)) {
      output = output.replace(/<\/head\s*>/i, injection + "</head>");
    } else if (injection && /<\/body\s*>/i.test(output)) {
      output = output.replace(/<\/body\s*>/i, injection + "</body>");
    } else if (injection) {
      output += injection;
    }
  }

  $done(output === body ? {} : { body: output });
})();
