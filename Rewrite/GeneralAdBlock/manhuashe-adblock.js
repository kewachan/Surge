/**
 * Manhuashe AdBlock
 * Hide welfare tabbar and remove short-drama related nav/home items.
 */

let body = $response.body || "";
const url = ($request.url || "").toLowerCase();

if (!body || !/https?:\/\/comicapi\.manhuashe\.com\//.test(url)) {
  $done({ body });
  return;
}

const isJsonText = (text) => {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[") || t.startsWith('"');
};

const normalize = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function isShortDramaNode(obj) {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const collect = [];
  const keys = [
    "title",
    "name",
    "route_url",
    "route",
    "routeUrl",
    "routepath",
    "url",
    "tab",
    "icon",
    "section_name",
    "module",
    "module_type",
    "type",
    "label",
    "ad_text",
    "text",
  ];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
      collect.push(normalize(obj[key]));
    }
  }

  const route = normalize(obj.route_url || obj.route || obj.routeUrl || obj.path || "");
  const type = normalize(obj.type);
  const text = collect.join(" ");
  const combined = `${text} ${route} ${type}`;

  if (/\bshort\b|\bdrama\b|\bwebtoon\b|\bshortvideo\b/.test(combined)) {
    // Avoid over-blocking normal manga titles; require nav-like signals too.
    const hasNavShape =
      Object.prototype.hasOwnProperty.call(obj, "route_url") ||
      Object.prototype.hasOwnProperty.call(obj, "route") ||
      Object.prototype.hasOwnProperty.call(obj, "routeUrl") ||
      Object.prototype.hasOwnProperty.call(obj, "icon") ||
      Object.prototype.hasOwnProperty.call(obj, "title") ||
      Object.prototype.hasOwnProperty.call(obj, "name");

    if (hasNavShape) {
      return true;
    }
  }

  // Keep a strict fallback for explicit short-drama labels in Chinese.
  if (/短劇|短剧/.test(text)) {
    return true;
  }

  return false;
}

function isAdNode(obj) {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(obj, "ad_id")) {
    const adId = Number(obj.ad_id);
    return Number.isNaN(adId) ? !!obj.ad_id : adId > 0;
  }

  return false;
}

function setWelfareTabbarOff(obj) {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  if (Array.isArray(obj)) {
    let changed = false;
    for (let i = obj.length - 1; i >= 0; i -= 1) {
      const item = obj[i];
      if (isAdNode(item) || isShortDramaNode(item)) {
        obj.splice(i, 1);
        changed = true;
      } else if (setWelfareTabbarOff(item)) {
        changed = true;
      }
    }
    return changed;
  }

  if (obj.base && typeof obj.base === "object") {
    if (obj.base.welfare_tabbar_show === 1 || obj.base.welfare_tabbar_show === "1") {
      obj.base.welfare_tabbar_show = 0;
      return true;
    }
  }

  let changed = false;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (isShortDramaNode(value) || isAdNode(value)) {
      if (Array.isArray(obj) || typeof key === "string") {
        obj[key] = null;
        changed = true;
      }
      continue;
    }

    if (typeof value === "object" && setWelfareTabbarOff(value)) {
      changed = true;
    }

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        const item = value[i];
        if (isShortDramaNode(item) || isAdNode(item)) {
          value.splice(i, 1);
          changed = true;
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(obj, "sections") && Array.isArray(obj.sections)) {
    for (let i = obj.sections.length - 1; i >= 0; i -= 1) {
      const sec = obj.sections[i];

      if (isAdNode(sec)) {
        obj.sections.splice(i, 1);
        changed = true;
        continue;
      }

      if (isShortDramaNode(sec)) {
        obj.sections.splice(i, 1);
        changed = true;
        continue;
      }

      if (isShortDramaNode(sec?.title) || isShortDramaNode(sec?.module) || isShortDramaNode(sec?.name)) {
        obj.sections.splice(i, 1);
        changed = true;
        continue;
      }

      const csec = sec.comic_section || sec.topic_section || sec.rank_section;
      if (csec && (isShortDramaNode(csec) || isAdNode(csec))) {
        obj.sections.splice(i, 1);
        changed = true;
      }
    }
  }

  return changed;
}

let changed = false;

if (isJsonText(body)) {
  try {
    const json = JSON.parse(body);
    const response = json.response && typeof json.response === "object" ? json.response : json;

    changed = setWelfareTabbarOff(response);

    // If we cleaned nested response object, keep original wrapper shape.
    if (response !== json) {
      body = JSON.stringify(json);
    } else {
      body = JSON.stringify(response);
    }
  } catch (err) {
    // fallback to raw replacements
  }
}

if (!changed) {
  body = body.replace(/("welfare_tabbar_show"\s*:\s*)1/gi, '$10');
}

$done({ body });
