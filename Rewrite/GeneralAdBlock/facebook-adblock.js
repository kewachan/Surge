/**
 * Facebook Web AdBlock for Surge — v1.0.6
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
  var SEPARATOR_ATTRIBUTE = "data-surge-facebook-separator";
  var ACTION_PATTERN = /(?:^|[\\s_-])(?:like|unlike|comment|comments|share|refresh|reload)(?:\\b|[_-]|$)|^(?:讚好|取消讚好|赞|取消赞|留言|評論|评论|分享|重新整理|重新載入|重新加载|刷新)/i;
  var BUTTON_SELECTOR = "a,button,[role=\\"button\\"]";
  var WEBLITE_ACTION_SELECTOR = "[data-action-id],[data-on-touch-up-action-id]";
  var SELECTOR = BUTTON_SELECTOR + ",[role=\\"progressbar\\"],[aria-label]";
  var dynamicScanTimer = null;

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

  function colorChannels(value) {
    var match = String(value || "").match(
      /rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?/i
    );
    if (!match) return null;

    return {
      red: parseInt(match[1], 10),
      green: parseInt(match[2], 10),
      blue: parseInt(match[3], 10),
      alpha: match[4] === undefined ? 1 : parseFloat(match[4])
    };
  }

  function isNeutralColor(value, minimum, maximum) {
    var color = colorChannels(value);
    if (!color || color.alpha === 0) return false;

    var low = Math.min(color.red, color.green, color.blue);
    var high = Math.max(color.red, color.green, color.blue);
    return low >= minimum && high <= maximum && high - low <= 20;
  }

  function visibleRect(element) {
    if (!element || !element.getBoundingClientRect) return null;
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
    return rect;
  }

  function pillTarget(element, viewportWidth) {
    var current = element;

    for (var depth = 0; current && depth < 6; depth += 1) {
      var rect = visibleRect(current);
      if (rect) {
        var style = window.getComputedStyle(current);
        var radius = parseFloat(style.borderTopLeftRadius) || 0;
        var suitableWidth = rect.width >= viewportWidth * 0.24 &&
          rect.width <= viewportWidth * 0.39;
        var suitableHeight = rect.height >= 34 && rect.height <= 72;

        if (suitableWidth && suitableHeight && radius >= rect.height * 0.25 &&
            isNeutralColor(style.backgroundColor, 45, 100)) {
          return current;
        }
      }

      if (current.id === "screen-root" || current === document.body) break;
      current = current.parentElement;
    }

    return null;
  }

  function clearWebLiteActionRows() {
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!viewportWidth) return;

    var actions = document.querySelectorAll(WEBLITE_ACTION_SELECTOR);
    var pills = [];

    for (var index = 0; index < actions.length; index += 1) {
      var pill = pillTarget(actions[index], viewportWidth);
      if (pill && pills.indexOf(pill) === -1) pills.push(pill);
    }

    for (var pillIndex = 0; pillIndex < pills.length; pillIndex += 1) {
      var reference = visibleRect(pills[pillIndex]);
      if (!reference) continue;

      var row = pills.filter(function (candidate) {
        var rect = visibleRect(candidate);
        return rect && Math.abs(rect.top - reference.top) <= 8 &&
          Math.abs(rect.height - reference.height) <= 8;
      });

      if (row.length < 3) continue;
      row.sort(function (left, right) {
        return visibleRect(left).left - visibleRect(right).left;
      });

      var first = visibleRect(row[0]);
      var last = visibleRect(row[row.length - 1]);
      if (!first || !last || last.right - first.left < viewportWidth * 0.78) continue;

      row.forEach(function (target) {
        target.setAttribute(ACTION_ATTRIBUTE, "1");
        target.style.setProperty("background", "transparent", "important");
        target.style.setProperty("background-color", "transparent", "important");
        target.style.setProperty("border-color", "transparent", "important");
        target.style.setProperty("box-shadow", "none", "important");
      });
    }
  }

  function isMediaControl(element) {
    return Boolean(element.closest && element.closest(
      "video,[role=\\"slider\\"],[role=\\"progressbar\\"]," +
      ".inline-video-progress-bar-container,.inline-video-progress-bar"
    ));
  }

  function clearWebLiteSeparators() {
    var root = document.getElementById("screen-root");
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!root || !viewportWidth) return;

    var elements = root.querySelectorAll("div");
    for (var index = 0; index < elements.length; index += 1) {
      var element = elements[index];
      var rect = visibleRect(element);
      if (!rect || rect.top < 80 || rect.width < viewportWidth * 0.85 ||
          isMediaControl(element)) continue;

      var style = window.getComputedStyle(element);
      var changed = false;

      if (rect.height <= 8 && isNeutralColor(style.backgroundColor, 55, 230)) {
        element.style.setProperty("background-color", "#000", "important");
        changed = true;
      }

      var topWidth = parseFloat(style.borderTopWidth) || 0;
      if (topWidth > 0 && topWidth <= 8 &&
          isNeutralColor(style.borderTopColor, 55, 230)) {
        element.style.setProperty("border-top-color", "#000", "important");
        changed = true;
      }

      var bottomWidth = parseFloat(style.borderBottomWidth) || 0;
      if (bottomWidth > 0 && bottomWidth <= 8 &&
          isNeutralColor(style.borderBottomColor, 55, 230)) {
        element.style.setProperty("border-bottom-color", "#000", "important");
        changed = true;
      }

      if (changed) {
        element.setAttribute(SEPARATOR_ATTRIBUTE, "1");
        element.style.setProperty("box-shadow", "none", "important");
      }
    }
  }

  function scheduleDynamicScan() {
    if (dynamicScanTimer !== null) return;
    dynamicScanTimer = window.setTimeout(function () {
      dynamicScanTimer = null;
      clearWebLiteActionRows();
      clearWebLiteSeparators();
    }, 160);
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
    scheduleDynamicScan();

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
      scheduleDynamicScan();
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
  background-color: #242527 !important;
}

html::before {
  content: "";
  position: fixed;
  z-index: 2147483647;
  top: 0;
  right: 0;
  left: 0;
  height: env(safe-area-inset-top);
  background-color: #242527 !important;
  pointer-events: none;
}

body,
#app-body,
#screen-root,
#root,
#viewport,
#page {
  background-color: #242527 !important;
}

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

.pull-to-refresh-spinner {
  background-color: transparent !important;
}

.pull-to-refresh-spinner-shadow {
  box-shadow: none !important;
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
}

[data-surge-facebook-separator="1"] {
  border-top-color: #000 !important;
  border-bottom-color: #000 !important;
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
  output = setMetaContent(output, "theme-color", "#242527");

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
