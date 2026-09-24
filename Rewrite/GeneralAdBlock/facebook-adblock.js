/**
 * Facebook Web AdBlock for Surge — v1.0.13
 * Removes "Open app" calls to action from mobile Facebook pages while
 * preserving navigation, playback controls, and feed content. Also applies a
 * Facebook-toned iOS status bar and black feed separators in the standalone
 * web app without altering post action or pull-to-refresh controls.
 */

(function () {
  "use strict";

  const MARKER = "data-surge-facebook-open-app-v13";
  const STYLE_MARKER = "data-surge-facebook-dark-ui-v13";

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
  var SEPARATOR_ATTRIBUTE = "data-surge-facebook-separator";
  var BUTTON_SELECTOR = "a,button,[role=\\"button\\"]";
  var WEBLITE_ACTION_SELECTOR = "[data-action-id],[data-on-touch-up-action-id]";
  var SELECTOR = BUTTON_SELECTOR + ",[aria-label]";
  var dynamicScanTimer = null;

  function normalizedText(element) {
    return String(element.textContent || "")
      .replace(/\\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isOpenAppElement(element) {
    if (!element) return false;
    var labels = [
      normalizedText(element),
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ];

    return labels.some(function (label) {
      return String(label || "").replace(/\\s+/g, " ").trim().toLowerCase() === LABEL;
    });
  }

  function containingButton(node) {
    if (!node) return null;
    var element = node.nodeType === 1 ? node : node.parentElement;
    return element && element.closest ? element.closest(BUTTON_SELECTOR) : null;
  }

  function expandedTarget(element) {
    var clickable = element.closest && element.closest(
      BUTTON_SELECTOR + "," + WEBLITE_ACTION_SELECTOR
    );
    var target = clickable && isOpenAppElement(clickable) ? clickable : element;

    for (var depth = 0; depth < 5; depth += 1) {
      var parent = target.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (parent.matches("header,nav,main,[role=\\"navigation\\"]")) break;
      if (!isOpenAppElement(parent)) break;
      target = parent;
    }

    return target;
  }

  function hideButton(element) {
    if (!isOpenAppElement(element)) return;

    var target = expandedTarget(element);
    if (target.getAttribute(HIDDEN_ATTRIBUTE) === "1") return;

    target.style.setProperty("display", "none", "important");
    target.setAttribute(HIDDEN_ATTRIBUTE, "1");
    target.setAttribute("aria-hidden", "true");
  }

  function hideOpenAppElements() {
    var root = document.body || document.getElementById("screen-root");
    if (!root) return;

    var elements = root.querySelectorAll(
      "a,button,[role=\\"button\\"],[data-action-id]," +
      "[data-on-touch-up-action-id],span,.native-text"
    );
    for (var index = 0; index < elements.length; index += 1) {
      hideButton(elements[index]);
    }
  }

  function processButton(element) {
    hideButton(element);
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

  function coordinateScale(viewportWidth) {
    var cssWidth = window.innerWidth || document.documentElement.clientWidth ||
      viewportWidth;
    var scale = cssWidth > 0 ? viewportWidth / cssWidth : 1;

    return scale >= 1 && scale <= 4 ? scale : 1;
  }

  function setImportantStyle(element, property, value) {
    if (!element) return;
    if (element.style.getPropertyValue(property) === value &&
        element.style.getPropertyPriority(property) === "important") return;
    element.style.setProperty(property, value, "important");
  }

  function applyWebLiteStaticFixes() {
    var baseElements = [
      document.documentElement,
      document.body,
      document.getElementById("app-body"),
      document.getElementById("screen-root")
    ];

    baseElements.forEach(function (element) {
      if (element) {
        setImportantStyle(element, "background-color", "#242527");
      }
    });

    var loadingTracks = document.querySelectorAll(".loading-bar-background");
    for (var trackIndex = 0; trackIndex < loadingTracks.length; trackIndex += 1) {
      setImportantStyle(loadingTracks[trackIndex], "background", "#242527");
      setImportantStyle(loadingTracks[trackIndex], "background-color", "#242527");
      setImportantStyle(loadingTracks[trackIndex], "box-shadow", "none");
    }

    var loadingProgress = document.querySelectorAll(".loading-bar-animation");
    for (var progressIndex = 0; progressIndex < loadingProgress.length;
         progressIndex += 1) {
      var progress = loadingProgress[progressIndex];
      var fill = progress.closest(".revamped-progress-bar-color") ?
        "linear-gradient(90deg, #004cc6, #0079ff)" : "#1877f2";
      setImportantStyle(progress, "background", fill);
    }

  }

  function isMediaControl(element) {
    return Boolean(element.closest && element.closest(
      "video,[role=\\"slider\\"],[role=\\"progressbar\\"]," +
      ".inline-video-progress-bar-container,.inline-video-progress-bar"
    ));
  }

  function isPullToRefreshControl(element) {
    return Boolean(element.closest && element.closest(
      ".pull-to-refresh-spinner-container,.pull-to-refresh-spinner," +
      ".pull-to-refresh-spinner-shadow,.pull-to-refresh-spinner-icon"
    ));
  }

  function clearWebLiteSeparators() {
    var root = document.getElementById("screen-root");
    if (!root) return;

    var rootRect = visibleRect(root);
    var viewportWidth = rootRect ? rootRect.width :
      (window.innerWidth || document.documentElement.clientWidth || 0);
    if (!viewportWidth) return;
    var scale = coordinateScale(viewportWidth);

    var elements = root.querySelectorAll(
      "div,section,article,header,footer,nav,main,aside,hr,ul,ol,li,form"
    );
    for (var index = 0; index < elements.length; index += 1) {
      var element = elements[index];
      var rect = visibleRect(element);
      if (!rect || rect.width < viewportWidth * 0.85 ||
          element.matches(".loading-bar-background,.loading-bar-animation") ||
          isMediaControl(element) || isPullToRefreshControl(element)) continue;

      var style = window.getComputedStyle(element);
      var normalizedHeight = rect.height / scale;
      var radius = Math.max(
        parseFloat(style.borderTopLeftRadius) || 0,
        parseFloat(style.borderTopRightRadius) || 0,
        parseFloat(style.borderBottomLeftRadius) || 0,
        parseFloat(style.borderBottomRightRadius) || 0
      ) / scale;
      if (normalizedHeight > 8 && radius > 8) continue;

      var changed = false;

      if (normalizedHeight <= 8 &&
          isNeutralColor(style.backgroundColor, 40, 255)) {
        setImportantStyle(element, "background-color", "#000");
        changed = true;
      }

      var topWidth = (parseFloat(style.borderTopWidth) || 0) / scale;
      if (topWidth > 0 && topWidth <= 8 &&
          isNeutralColor(style.borderTopColor, 40, 255)) {
        setImportantStyle(element, "border-top-color", "#000");
        changed = true;
      }

      var bottomWidth = (parseFloat(style.borderBottomWidth) || 0) / scale;
      if (bottomWidth > 0 && bottomWidth <= 8 &&
          isNeutralColor(style.borderBottomColor, 40, 255)) {
        setImportantStyle(element, "border-bottom-color", "#000");
        changed = true;
      }

      var outlineWidth = (parseFloat(style.outlineWidth) || 0) / scale;
      if (outlineWidth > 0 && outlineWidth <= 8 &&
          isNeutralColor(style.outlineColor, 40, 255)) {
        setImportantStyle(element, "outline-color", "#000");
        changed = true;
      }

      if (style.boxShadow && style.boxShadow !== "none") {
        setImportantStyle(element, "box-shadow", "none");
        changed = true;
      }

      ["::before", "::after"].forEach(function (pseudo) {
        var pseudoStyle = window.getComputedStyle(element, pseudo);
        var content = String(pseudoStyle.content || "").toLowerCase();
        var pseudoHeight = (parseFloat(pseudoStyle.height) || 0) / scale;
        var pseudoTopWidth = (parseFloat(pseudoStyle.borderTopWidth) || 0) / scale;
        var pseudoBottomWidth =
          (parseFloat(pseudoStyle.borderBottomWidth) || 0) / scale;
        var hasContent = content !== "" && content !== "none" &&
          content !== "normal";
        var isThin = pseudoHeight <= 8 &&
          (pseudoHeight > 0 || pseudoTopWidth > 0 || pseudoBottomWidth > 0);
        if (hasContent && isThin &&
            (isNeutralColor(pseudoStyle.backgroundColor, 40, 255) ||
             isNeutralColor(pseudoStyle.borderTopColor, 40, 255) ||
             isNeutralColor(pseudoStyle.borderBottomColor, 40, 255))) {
          changed = true;
        }
      });

      if (changed) {
        element.setAttribute(SEPARATOR_ATTRIBUTE, "1");
        setImportantStyle(element, "box-shadow", "none");
      }
    }
  }

  function scheduleDynamicScan() {
    if (dynamicScanTimer !== null) return;
    dynamicScanTimer = window.setTimeout(function () {
      dynamicScanTimer = null;
      applyWebLiteStaticFixes();
      hideOpenAppElements();
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

#screen-root::before {
  content: none !important;
  display: none !important;
}

.loading-bar-background,
.revamped-progress-bar-color .loading-bar-background {
  background: #242527 !important;
  background-color: #242527 !important;
  box-shadow: none !important;
}

.loading-bar-animation {
  background: #1877f2 !important;
}

.revamped-progress-bar-color .loading-bar-animation {
  background: linear-gradient(90deg, #004cc6, #0079ff) !important;
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

[data-surge-facebook-separator="1"] {
  border-top-color: #000 !important;
  border-bottom-color: #000 !important;
  box-shadow: none !important;
}

[data-surge-facebook-separator="1"]::before,
[data-surge-facebook-separator="1"]::after {
  background-color: #000 !important;
  border-color: #000 !important;
  box-shadow: none !important;
}

[data-surge-open-app-hidden="1"] {
  display: none !important;
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
