/**
 * Manhuashe AdBlock
 * Hide welfare tabbar and remove short-drama related nav/home items.
 */

let body = $response.body || "";
const url = ($request.url || "");
const urlLower = url.toLowerCase();

if (!body || !/https?:\/\/comicapi\.manhuashe\.com\//.test(urlLower)) {
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

const containsShortDramaKeyword = (value) => {
  const text = normalize(value);
  return /\bshort\b|\bdrama\b|\bshortvideo\b|\bwebtoon\b|短剧|短片|短影片|短視頻/.test(text);
};

function isAdNode(obj) {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(obj, "ad_id")) {
    const adId = Number(obj.ad_id);
    return Number.isNaN(adId) ? true : adId > 0;
  }

  return false;
}

function isShortDramaNode(obj) {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const hasRouteLikeKey = ["route_url", "route", "routeUrl", "path", "url"].some(
    (key) => Object.prototype.hasOwnProperty.call(obj, key)
  );

  const collect = [
    obj.title,
    obj.name,
    obj.name_short,
    obj.section_name,
    obj.label,
    obj.type,
    obj.tab,
    obj.icon,
    obj.module,
    obj.module_type,
    obj.ad_text,
    obj.text,
    obj.route_url,
    obj.route,
    obj.routeUrl,
    obj.path,
    obj.url,
  ]
    .filter((v) => v != null)
    .map(normalize)
    .join(" ");

  const route = normalize(obj.route_url || obj.route || obj.routeUrl || obj.path || obj.url || "");
  return (
    containsShortDramaKeyword(collect) ||
    (containsShortDramaKeyword(route) && hasRouteLikeKey)
  );
}

function cleanSections(response) {
  if (!Array.isArray(response.sections)) {
    return false;
  }

  let changed = false;
  for (let i = response.sections.length - 1; i >= 0; i -= 1) {
    const section = response.sections[i];
    if (!section || typeof section !== "object") {
      continue;
    }

    const child = section.comic_section || section.topic_section || section.rank_section || section.banner_section;
    const sectionTitle = normalize(
      (section.title || section.name || section.section_name || (child && (child.title || child.name)) || "")
    );

    if (
      isAdNode(section) ||
      isAdNode(child) ||
      isShortDramaNode(section) ||
      isShortDramaNode(child) ||
      containsShortDramaKeyword(sectionTitle)
    ) {
      response.sections.splice(i, 1);
      changed = true;
      continue;
    }

    if (Array.isArray(section.items)) {
      section.items = section.items.filter((item) => !isAdNode(item) && !isShortDramaNode(item));
      if (section.items.length === 0 && Object.keys(section).every((k) => k === "section_id" || k === "type" || k === "items")) {
        response.sections.splice(i, 1);
        changed = true;
      }
    }

    for (const key of ["comic_section", "topic_section", "rank_section"]) {
      if (section[key]) {
        const changedChild = cleanNested(section[key]);
        changed = changed || changedChild;
      }
    }
  }
  return changed;
}

function cleanNested(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  let changed = false;

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const item = value[i];
      if (isAdNode(item) || isShortDramaNode(item)) {
        value.splice(i, 1);
        changed = true;
      } else if (cleanNested(item)) {
        changed = true;
      }
    }
    return changed;
  }

  if (isAdNode(value) || isShortDramaNode(value)) {
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(value, "base") && value.base && typeof value.base === "object") {
    if (value.base.welfare_tabbar_show === 0 || value.base.welfare_tabbar_show === "0") {
      value.base.welfare_tabbar_show = 1;
      changed = true;
    }
  }

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (Array.isArray(child) || (child && typeof child === "object")) {
      if (cleanNested(child)) {
        if (Array.isArray(value) === false && (child && typeof child === "object") && isAdNode(child)) {
          delete value[key];
          changed = true;
        } else {
          changed = true;
        }
      }
    }
  }

  return changed;
}

function setWelfareTabbarOff(response) {
  let changed = false;

  if (!response || typeof response !== "object") {
    return false;
  }

  if (response.base && typeof response.base === "object") {
    if (response.base.welfare_tabbar_show === 0 || response.base.welfare_tabbar_show === "0") {
      response.base.welfare_tabbar_show = 1;
      changed = true;
    }
  }

  if (Array.isArray(response.sections)) {
    changed = cleanSections(response) || changed;
  }
  changed = cleanNested(response) || changed;

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
  body = body.replace(/("welfare_tabbar_show"\s*:\s*)0/gi, '$11');
}

$done({ body });
