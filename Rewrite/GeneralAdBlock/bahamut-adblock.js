// Token requests start validation; playback waits only for the remaining interval.
(function () {
  "use strict";
  const WAIT_MS = 25000;
  const TTL_MS = 120000;
  const HTTP_TIMEOUT_SECONDS = 3;
  const KEY = "bahamut_ad_prewarm_v2";
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
        && value && ["starting", "pending", "ending", "complete"].includes(value.phase)
        && Number.isFinite(value.updatedAt) && value.updatedAt <= now && now - value.updatedAt < TTL_MS
        && (!["pending", "ending"].includes(value.phase) ||
          (Number.isFinite(value.startedAt) && value.startedAt <= now && now - value.startedAt < TTL_MS))));
    } catch (_) { return {}; }
  }

  function saveState(sn, state) {
    if (completed) return;
    const states = readStates();
    if (state) states[sn] = {...state, updatedAt: Date.now()};
    else delete states[sn];
    const entries = Object.entries(states).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 8);
    $persistentStore.write(JSON.stringify(Object.fromEntries(entries)), KEY);
  }

  function clearOwnedState() {
    const sn = videoSn();
    if (sn && readStates()[sn]?.owner === owner) saveState(sn, null);
  }

  function videoSn() {
    const match = /[?&]sn=(\d{1,20})(?:&|$)/.exec(url);
    return match?.[1] || "";
  }

  function hasError(body) {
    if (!body || typeof body !== "object") return false;
    if (body.error || body.success === false || body.ok === false) return true;
    if (typeof body.code === "number" && body.code !== 0 && body.code !== 200) return true;
    const source = body.src || body.url || body.data?.src || body.data?.url;
    return Boolean(body.message && !source && !/^(?:ok|success)$/i.test(String(body.message).trim()));
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

  async function start(sn) {
    const previous = readStates()[sn];
    if (previous?.phase === "pending" || previous?.phase === "complete") return previous;
    if (previous && Date.now() - previous.updatedAt < 4000) throw new Error("Ad validation is already running");
    saveState(sn, {phase: "starting", owner});
    try {
      await report("", sn);
      const state = {phase: "pending", startedAt: Date.now(), owner};
      saveState(sn, state);
      return state;
    } catch (error) { clearOwnedState(); throw error; }
  }

  async function validate(sn) {
    let state = readStates()[sn];
    if (state?.phase === "complete") { saveState(sn, null); state = null; }
    if (!state || state.phase !== "pending") state = await start(sn);
    const remaining = Math.max(0, WAIT_MS - (Date.now() - state.startedAt));
    if (!Number.isFinite(remaining) || Date.now() + remaining + 6500 >= deadline) throw new Error("Insufficient validation time budget");
    if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
    if (completed) return;
    const refreshed = readStates()[sn];
    if (refreshed?.phase === "complete") return;
    if (refreshed?.phase !== "pending" || refreshed.startedAt !== state.startedAt) throw new Error("Validation state changed");
    saveState(sn, {...state, phase: "ending", owner});
    await report("end", sn);
    saveState(sn, {phase: "complete", owner});
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
    if (!/\/(?:m3u8|video_src)\.php(?:\?|$)/.test(url) || !hasError(body)) return {};
    await validate(sn);
    if (completed) return {};
    const text = await fetchText(url);
    const retried = JSON.parse(text);
    if (!retried || typeof retried !== "object" || Array.isArray(retried) || hasError(retried)) {
      throw new Error("Playback source is still unavailable");
    }
    return {body: text};
  }

  main().then(finish).catch(error => {
    if (completed) return;
    clearOwnedState();
    console.log(`[BahamutAnimeAds] ${error.message || "Validation failed"}; original response kept`);
    finish({});
  });
})();
