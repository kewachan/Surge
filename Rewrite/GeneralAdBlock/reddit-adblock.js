/**
 * Reddit AdBlock for Surge — v1.0.0
 * Removes promoted posts from JSON and GraphQL multipart responses while
 * preserving normal feed entries and disabling NSFW content prompts.
 */

(function () {
  "use strict";

  const DROP = {};

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasAdCell(cells) {
    return Array.isArray(cells) && cells.some(function (cell) {
      return isObject(cell) &&
        (cell.__typename === "AdMetadataCell" || cell.isAdPost === true);
    });
  }

  function isAdObject(value) {
    if (!isObject(value)) return false;

    if (value.__typename === "AdPost" || value.isAdPost === true ||
        isObject(value.adPayload) || hasAdCell(value.cells)) {
      return true;
    }

    const node = value.node;
    return isObject(node) &&
      (node.__typename === "AdPost" || node.isAdPost === true ||
       isObject(node.adPayload) || hasAdCell(node.cells));
  }

  function cleanValue(value, state) {
    if (Array.isArray(value)) {
      const result = [];
      value.forEach(function (item) {
        const cleaned = cleanValue(item, state);
        if (cleaned !== DROP) result.push(cleaned);
      });
      return result;
    }

    if (!isObject(value)) return value;

    if (isAdObject(value)) {
      state.changed = true;
      return DROP;
    }

    if (value.isNsfw === true) {
      value.isNsfw = false;
      state.changed = true;
    }
    if (value.isNsfwMediaBlocked === true) {
      value.isNsfwMediaBlocked = false;
      state.changed = true;
    }
    if (value.isNsfwContentShown === false) {
      value.isNsfwContentShown = true;
      state.changed = true;
    }
    if (Array.isArray(value.commentsPageAds) && value.commentsPageAds.length > 0) {
      value.commentsPageAds = [];
      state.changed = true;
    }

    Object.keys(value).forEach(function (key) {
      const cleaned = cleanValue(value[key], state);
      if (cleaned === DROP) {
        delete value[key];
      } else {
        value[key] = cleaned;
      }
    });

    return value;
  }

  function transformJson(text) {
    try {
      const state = { changed: false };
      const cleaned = cleanValue(JSON.parse(text), state);
      if (cleaned === DROP || !state.changed) return null;
      return JSON.stringify(cleaned);
    } catch (_) {
      return null;
    }
  }

  function headerValue(headers, name) {
    const target = name.toLowerCase();
    const key = Object.keys(headers || {}).find(function (candidate) {
      return candidate.toLowerCase() === target;
    });
    return key ? String(headers[key]) : "";
  }

  function multipartBoundary(contentType) {
    const match = contentType.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
    return match ? match[1] : "";
  }

  function transformMultipart(body, boundary) {
    const delimiter = "--" + boundary;
    if (!boundary || body.indexOf(delimiter) === -1) return null;

    let changed = false;
    const segments = body.split(delimiter).map(function (segment) {
      let separator = "\r\n\r\n";
      let separatorIndex = segment.indexOf(separator);
      if (separatorIndex === -1) {
        separator = "\n\n";
        separatorIndex = segment.indexOf(separator);
      }
      if (separatorIndex === -1) return segment;

      const prefixEnd = separatorIndex + separator.length;
      const content = segment.slice(prefixEnd);
      const leading = (content.match(/^\s*/) || [""])[0];
      const trailing = (content.match(/\s*$/) || [""])[0];
      const jsonEnd = content.length - trailing.length;
      const jsonText = content.slice(leading.length, jsonEnd);
      if (!jsonText) return segment;

      const transformed = transformJson(jsonText);
      if (transformed === null) return segment;

      changed = true;
      return segment.slice(0, prefixEnd) + leading + transformed + trailing;
    });

    return changed ? segments.join(delimiter) : null;
  }

  if (typeof $response.body !== "string") {
    $done({});
    return;
  }

  const contentType = headerValue($response.headers, "content-type");
  let body = null;

  if (/multipart\/mixed/i.test(contentType)) {
    body = transformMultipart($response.body, multipartBoundary(contentType));
  } else {
    body = transformJson($response.body);
  }

  $done(body === null ? {} : { body: body });
})();
