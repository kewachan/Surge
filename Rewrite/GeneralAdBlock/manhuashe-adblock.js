/**
 * Manhuashe AdBlock
 * Hide welfare tabbar by forcing welfare_tabbar_show to 0.
 */

let body = $response.body || "";
const url = $request.url || "";

const isManhuashe = /https?:\/\/comicapi\.manhuashe\.com\//.test(url);

if (!isManhuashe || !body) {
  $done({ body });
  return;
}

function setWelfareTabbarOff(obj) {
  let changed = false;

  if (!obj || typeof obj !== "object") {
    return changed;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) {
      if (setWelfareTabbarOff(obj[i])) {
        changed = true;
      }
    }
    return changed;
  }

  if (obj.base && typeof obj.base === "object") {
    if (obj.base.welfare_tabbar_show === 1 || obj.base.welfare_tabbar_show === "1") {
      obj.base.welfare_tabbar_show = 0;
      changed = true;
    }
  }

  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      continue;
    }
    if (setWelfareTabbarOff(obj[key])) {
      changed = true;
    }
  }

  return changed;
}

const trimmed = body.trim();
let changed = false;

if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
  try {
    const json = JSON.parse(body);
    changed = setWelfareTabbarOff(json);
    if (changed) {
      body = JSON.stringify(json);
    }
  } catch (err) {
    // fallback to raw replace
  }
}

if (!changed) {
  body = body.replace(/("welfare_tabbar_show"\s*:\s*)1/gi, '$10');
}

$done({ body });
