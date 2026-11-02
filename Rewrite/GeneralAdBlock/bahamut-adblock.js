// Token requests start validation; playback waits only for the remaining interval.
(function () {
  "use strict";
  const WAIT_MS = 25000;
  const TTL_MS = 120000;
  const HTTP_TIMEOUT_SECONDS = 3;
  const KEY = "bahamut_ad_prewarm_v3";
  const url = $request.url || "";
  const budget = /\/token\.php(?:\?|$)/.test(url) ? 4000 : 36000;
  const owner = `${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + budget;
  let completed = false;
  const timer = setTimeout(() => {
    clearOwnedState();
    console.log("[BahamutAnimeAds] Validation time budget exhausted; original response kept");
    finish({});
  }, budget);

  function finish(result) {
    if (completed) return;
    completed = true;
    if (typeof clearTimeout === "function") clearTimeout(timer);
    $done(result);
  }

  function readStates() {
    try {
      const saved = JSON.parse($persistentStore.read(KEY) || "{}");
      const now = Date.now();
      return Object.fromEntries(Object.entries(saved).filter(([sn, value]) => /^\d{1,20}$/.test(sn)
        && value && ["starting", "pending", "ending", "ready", "complete"].includes(value.phase)
        && typeof value.generation === "string" && value.generation.length > 0
        && Number.isFinite(value.updatedAt) && value.updatedAt <= now && now - value.updatedAt < TTL_MS
        && (value.phase === "starting" ||
          (Number.isFinite(value.startedAt) && value.startedAt <= now && now - value.startedAt < TTL_MS))
        && (value.phase !== "complete" || value.sourceValidated === true)));
    } catch (_) { return {}; }
  }

  function saveState(sn, state) {
    if (completed) return false;
    const states = readStates();
    if (state) states[sn] = {...state, updatedAt: Date.now()};
    else delete states[sn];
    const entries = Object.entries(states).sort((a, b) => b[1].updatedAt - a[1].updatedAt
      || Number(b[0] === sn) - Number(a[0] === sn)).slice(0, 8);
    try { return $persistentStore.write(JSON.stringify(Object.fromEntries(entries)), KEY) !== false; }
    catch (_) { return false; }
  }

  function clearOwnedState(preserveReady = false) {
    const sn = videoSn();
    const state = sn ? readStates()[sn] : null;
    if (state?.owner === owner && !(preserveReady && state.phase === "ready")) saveState(sn, null);
  }

  function videoSn() {
    const matches = url.matchAll(/[?&](?:sn|videoSn)=([^&#]*)/gi);
    const values = new Set();
    for (const match of matches) {
      let value;
      try { value = decodeURIComponent(match[1]); } catch (_) { return ""; }
      if (!/^\d{1,20}$/.test(value)) return "";
      values.add(value);
    }
    return values.size === 1 ? [...values][0] : "";
  }

  function hasError(body) {
    if (!body || typeof body !== "object") return false;
    if (body.error || body.success === false || body.ok === false) return true;
    if (body.code !== undefined && !["0", "200"].includes(String(body.code))) return true;
    const source = body.src || body.url || body.data?.src || body.data?.url;
    return Boolean(body.message && !source && !/^(?:ok|success)$/i.test(String(body.message).trim()));
  }

  function adWaiting(body, sn) {
    if (!hasError(body)) return false;
    const message = [body.message, body.error?.message, typeof body.error === "string" ? body.error : ""]
      .filter(value => typeof value === "string").join(" ");
    if (/\b(?:login|log[ -]in|unauthori[sz]ed|region|geo[ -]?blocked|premium|payment)\b|登入|登錄|登录|地區限制|地区限制|裝置驗證|设备验证|付費|付费/.test(message.toLowerCase())) return false;
    const code = body.error?.code ?? body.code;
    // Known ad-wait code; all other explicit errors retain the server response.
    if (code !== undefined && !["0", "200"].includes(String(code))) return String(code) === "1015";
    const active = readStates()[sn];
    return /\bad(?:vertisement)?\s+(?:is\s+)?(?:required|pending|incomplete|not\s+(?:finished|completed|watched))\b/i.test(message)
      || /(?:廣告|广告).{0,20}(?:尚未|未完成|未結束|未结束|等待)|(?:尚未|請先|请先|等待).{0,20}(?:廣告|广告)/.test(message)
      // Older mobile responses can be generic; a verified ad-bearing token is
      // the context needed to keep their existing validation path compatible.
      || Boolean(active && ["pending", "ending", "ready"].includes(active.phase));
  }

  function hasPlaybackSource(value, depth = 0) {
    if (depth > 4) return false;
    if (typeof value === "string") return /^https?:\/\/[^\s]+$/i.test(value);
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(item => hasPlaybackSource(item, depth + 1));
    return ["src", "url", "playlist", "m3u8", "sources", "data"].some(key => hasPlaybackSource(value[key], depth + 1));
  }

  function hasAdSlots(body) {
    return [body.ad, body.data?.ad].some(ad => ad && [ad.major, ad.minor].some(slots => Array.isArray(slots) && slots.length));
  }

  function clearAdSlots(body) {
    for (const ad of [body.ad, body.data?.ad]) if (ad && typeof ad === "object") {
      if (Array.isArray(ad.major)) ad.major = [];
      if (Array.isArray(ad.minor)) ad.minor = [];
    }
  }

  function fetchText(target) {
    return new Promise((resolve, reject) => {
      if (completed || deadline - Date.now() < 100) return reject(new Error("Validation time budget exhausted"));
      const headers = Object.fromEntries(Object.entries($request.headers || {}).filter(([name]) =>
        !/^(?:host|content-length|content-encoding|transfer-encoding)$/i.test(name)));
      $httpClient.get({url: target, headers,
        timeout: Math.min(HTTP_TIMEOUT_SECONDS, (deadline - Date.now()) / 1000),
        "auto-redirect": false, "auto-cookie": false}, (error, response, body) => {
        if (completed) return;
        const status = Number(response?.status ?? response?.statusCode);
        if (error || status < 200 || status >= 300 || !Number.isFinite(status)) {
          reject(new Error(error ? "Validation request failed" : `Validation HTTP ${status || "unknown"}`));
        } else resolve(String(body || ""));
      });
    });
  }

  async function report(stage, sn) {
    const text = await fetchText("https://api.gamer.com.tw/mobile_app/anime/v1/stat_ad.php" +
      `?ad=${stage}&schedule=0&sn=${sn}`);
    if (!text.trim()) return;
    let body;
    try { body = JSON.parse(text); } catch (_) { throw new Error("Invalid validation response"); }
    if (body === false || hasError(body)) throw new Error("Ad validation was rejected");
  }

  async function changedState(sn, state, reserve) {
    while (!completed) {
      const current = readStates()[sn];
      if (!current || current.generation !== state.generation) throw new Error("Validation state changed");
      if (current.phase !== state.phase) return current;
      if (state.phase === "ending" && Date.now() - current.updatedAt >= 4000) throw new Error("Validation owner expired");
      if (deadline - Date.now() <= reserve) throw new Error("Insufficient validation time budget");
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now() - reserve)));
    }
    throw new Error("Validation time budget exhausted");
  }

  async function start(sn, fresh = false) {
    let previous = readStates()[sn];
    if (previous?.phase === "starting" && Date.now() - previous.updatedAt < 4000) {
      previous = await changedState(sn, previous, 100);
    }
    if (previous && previous.phase !== "starting" && !(fresh && ["ending", "ready", "complete"].includes(previous.phase))) return previous;
    if (!saveState(sn, {phase: "starting", generation: owner, owner})) throw new Error("Unable to reserve validation");
    try {
      await report("", sn);
      if (completed || readStates()[sn]?.owner !== owner) throw new Error("Validation state changed");
      const state = {phase: "pending", startedAt: Date.now(), generation: owner, owner};
      if (!saveState(sn, state)) throw new Error("Unable to save validation");
      return state;
    } catch (error) { clearOwnedState(); throw error; }
  }

  async function validate(sn) {
    let state = readStates()[sn];
    state = await start(sn, ["ending", "ready", "complete"].includes(state?.phase) && Date.now() - state.updatedAt >= 4000);
    if (state.phase === "complete" || state.phase === "ready") return state;
    if (state.phase === "ending") {
      const joined = await changedState(sn, state, 3500);
      if (["ready", "complete"].includes(joined.phase)) return joined;
      throw new Error("Validation state changed");
    }
    const remaining = Math.max(0, WAIT_MS - (Date.now() - state.startedAt));
    if (!Number.isFinite(remaining) || Date.now() + remaining + 6500 >= deadline) throw new Error("Insufficient validation time budget");
    if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
    if (completed) throw new Error("Validation time budget exhausted");
    let refreshed = readStates()[sn];
    if (refreshed?.generation !== state.generation) throw new Error("Validation state changed");
    if (refreshed.phase === "ending") refreshed = await changedState(sn, refreshed, 3500);
    if (["ready", "complete"].includes(refreshed.phase)) return refreshed;
    if (refreshed.phase !== "pending") throw new Error("Validation state changed");
    if (!saveState(sn, {...state, phase: "ending", owner})) throw new Error("Unable to save validation");
    await report("end", sn);
    if (completed || readStates()[sn]?.owner !== owner) throw new Error("Validation state changed");
    state = {...state, phase: "ready", owner};
    if (!saveState(sn, state)) throw new Error("Unable to save validation");
    return state;
  }

  async function main() {
    if (Number($response.status ?? $response.statusCode ?? 200) !== 200) return {};
    let body;
    try { body = JSON.parse($response.body || "null"); } catch (_) { return {}; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};
    const sn = videoSn();
    if (!sn) return {};
    if (/\/token\.php(?:\?|$)/.test(url)) {
      if (hasError(body) || !hasAdSlots(body)) return {};
      await start(sn);
      clearAdSlots(body);
      return {body: JSON.stringify(body)};
    }
    if (!/\/(?:m3u8|video_src)\.php(?:\?|$)/.test(url) || !adWaiting(body, sn)) return {};
    const validation = await validate(sn);
    if (completed) return {};
    const text = await fetchText(url);
    const retried = JSON.parse(text);
    if (!retried || typeof retried !== "object" || Array.isArray(retried) || hasError(retried) || !hasPlaybackSource(retried)) {
      throw new Error("Playback source is still unavailable");
    }
    const current = readStates()[sn];
    if (!current || current.generation === validation.generation) {
      saveState(sn, {...validation, phase: "complete", sourceValidated: true, owner});
    }
    return {body: text};
  }

  main().then(finish).catch(error => {
    if (completed) return;
    // An accepted end can serve other waiters briefly; it is not a playable source.
    clearOwnedState(true);
    console.log(`[BahamutAnimeAds] ${error.message || "Validation failed"}; original response kept`);
    finish({});
  });
})();
