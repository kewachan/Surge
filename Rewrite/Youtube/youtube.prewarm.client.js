// Playback-time prewarm bootstrap. Embedded into both response scripts by the build helper.
(() => {
  const options = {captionLang: "off", captionToken: "", lyricsLang: "off", lyricsToken: "", prewarm: true, debug: false};
  try {
    if (typeof $argument === "string" && !$argument.includes("{{{")) Object.assign(options, JSON.parse($argument));
    else if (typeof $argument === "object" && $argument) Object.assign(options, $argument);
  } catch (_) {}
  const plans = [];
  const INDEX = "YouTubeTranslation.PrewarmIndex.v1";
  const PENDING = "YouTubeTranslation.PrewarmPending.v1";
  const LEASE = "YouTubeTranslation.PrewarmLease.v1";
  const KICK = "YouTubeTranslation.PrewarmKick.v1";
  const PENDING_TTL_MS = 20 * 60 * 1000;
  const background = typeof $request === "undefined";
  const runId = `${Date.now()}:${Math.random()}`;
  const originalDone = $done;
  let finished = false;

  function language(value) {
    const text = String(value || "").trim();
    return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(text) && text.toLowerCase() !== "off" ? text : "";
  }
  function captionTarget(value) {
    return {"zh-hant": "zh-TW", "zh-tw": "zh-TW", "zh-hans": "zh-CN", "zh-cn": "zh-CN"}[value.toLowerCase()] || value;
  }
  function query(url, name) {
    const match = String(url).match(new RegExp(`[?&]${name}=([^&#]*)`));
    try { return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : ""; } catch (_) { return ""; }
  }
  function fingerprint(text) {
    let first = 2166136261, second = 2246822519;
    for (let index = 0; index < text.length; index++) {
      first = Math.imul(first ^ text.charCodeAt(index), 16777619);
      second = Math.imul(second ^ text.charCodeAt(index), 3266489917);
    }
    return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotateRight(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  function sha256(message) {
    const bitLength = message.length * 8;
    const totalLength = Math.ceil((message.length + 9) / 64) * 64;
    const padded = new Uint8Array(totalLength);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(totalLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(totalLength - 4, bitLength >>> 0, false);
    const hash = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < totalLength; offset += 64) {
      for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
      for (let index = 16; index < 64; index++) {
        const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index++) {
        const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temporary1 = (h + sigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
        const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temporary2 = (sigma0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temporary1) >>> 0;
        d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    for (let index = 0; index < hash.length; index++) outputView.setUint32(index * 4, hash[index], false);
    return output;
  }

  function identifier(value) {
    const text = JSON.stringify(value);
    const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text)
      : Uint8Array.from(unescape(encodeURIComponent(text)), (character) => character.charCodeAt(0));
    return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function sourceRoute(url) {
    return `YouTubeCaption.SourceRoute.v1.${fingerprint(JSON.stringify([query(url, "c"), query(url, "key"), query(url, "kind")]))}`;
  }
  function find(value, match, depth = 0) {
    if (!value || typeof value !== "object" || depth > 24) return null;
    const result = match(value); if (result) return result;
    for (const child of Object.values(value)) { const result = find(child, match, depth + 1); if (result) return result; }
    return null;
  }
  function prefetchLyrics(plan, budget, ready) {
    const sourceMs = Math.min(850, Math.max(0, budget - 100));
    if (sourceMs < 150) { ready(); return; }
    let settled = false;
    const deadline = Date.now() + sourceMs;
    const finish = (lines) => {
      if (settled || finished) return;
      settled = true; clearTimeout(timer);
      if (lines?.length && lines.length <= 384 && lines.every((line) => line.length <= 500) && lines.join("").length <= 19200) {
        plan.payload.sourceLines = lines;
        if (options.debug) console.log("YouTube lyrics prewarm: source: device");
      }
      ready();
    };
    const timer = setTimeout(() => finish(), sourceMs);
    const context = {client: {clientName: "WEB_REMIX", clientVersion: "1.20261026.01.00", hl: "en", gl: "HK"}};
    function api(path, payload, receive) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { finish(); return; }
      try {
        $httpClient.post({url: `https://music.youtube.com/youtubei/v1/${path}?prettyPrint=false`, timeout: remaining / 1000,
          headers: {"Content-Type": "application/json", Origin: "https://music.youtube.com"}, body: JSON.stringify({context, ...payload})},
        (error, response, body) => {
          if (settled || finished) return;
          if (error || Number(response?.status ?? response?.statusCode) !== 200 || typeof body !== "string" || body.length > 1500000) { finish(); return; }
          try { receive(JSON.parse(body)); } catch (_) { finish(); }
        });
      } catch (_) { finish(); }
    }
    // Public source requests carry no account headers, cookies or playback keys.
    api("next", {videoId: plan.payload.videoId}, (document) => {
      const browseId = find(document, (node) => /^MPLY[\w-]{1,300}$/.test(node.browseEndpoint?.browseId || "") ? node.browseEndpoint.browseId : null);
      if (!browseId) { finish(); return; }
      plan.payload.browseId = browseId;
      api("browse", {browseId}, (document) => {
        const description = find(document, (node) => node.musicDescriptionShelfRenderer?.description || null);
        const text = description?.runs?.map((run) => run.text || "").join("") || description?.simpleText || "";
        finish([...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]);
      });
    });
  }
  function findTracks(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return [];
    if (Array.isArray(value.captionTracks)) return value.captionTracks;
    for (const child of Object.values(value)) {
      const found = findTracks(child, depth + 1); if (found.length) return found;
    }
    return [];
  }
  function remember(key, value) {
    let wrote = false;
    try {
      if ($persistentStore.write(JSON.stringify(value), key) === false) return;
      wrote = true;
      let index;
      try { index = JSON.parse($persistentStore.read(INDEX) || "[]"); } catch (_) { index = []; }
      const owns = itemKey => typeof itemKey === "string" && /^YouTube(?:Caption|Lyrics)\.Prewarm\.v1\./.test(itemKey);
      const next = (Array.isArray(index) ? index : []).filter((item) => owns(item?.key) && item.key !== key);
      next.push({key});
      const remove = itemKey => { try { return $persistentStore.write(null, itemKey) !== false; } catch (_) { return false; } };
      while (next.length > 64 && remove(next[0].key)) next.shift();
      if ($persistentStore.write(JSON.stringify(next), INDEX) === false) remove(key);
    } catch (_) {
      if (wrote) { try { $persistentStore.write(null, key); } catch (_) {} }
    }
  }
  function recent(key, confirmedOnly = false) {
    try {
      const saved = JSON.parse($persistentStore.read(key) || "null");
      if (confirmedOnly && !(saved?.jobId && saved.confirmed !== false)) return false;
      const interval = key.startsWith("YouTubeLyrics.") ? 60000 : 600000;
      return saved && Date.now() - saved.savedAt < (saved.jobId && saved.confirmed !== false ? interval : 15000);
    } catch (_) { return false; }
  }
  function pendingPlans(checkOptions = true) {
    try {
      const saved = JSON.parse($persistentStore.read(PENDING) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved.filter(plan => {
        if (!plan || typeof plan.id !== "string" || !Number.isFinite(plan.queuedAt)
          || plan.queuedAt > Date.now() || Date.now() - plan.queuedAt >= PENDING_TTL_MS) return false;
        const target = language(checkOptions ? (plan.kind === "caption" ? options.captionLang : options.lyricsLang) : plan.payload?.target);
        if (!target || (checkOptions && (options.prewarm === false || options.prewarm === "false"))) return false;
        return plan.kind === "caption"
          ? /^YouTubeCaption\.Prewarm\.v1\./.test(plan.key || "") && plan.payload?.target === captionTarget(target)
            && /^https:\/\/www\.youtube\.com\/api\/timedtext\?/.test(plan.payload?.url || "") && plan.payload.url.length <= 12000
          : plan.kind === "lyrics" && /^YouTubeLyrics\.Prewarm\.v1\./.test(plan.key || "")
            && plan.payload?.target === target && /^[\w-]{11}$/.test(plan.payload?.videoId || "")
            && (!checkOptions || /^[a-f0-9]{64}$/i.test(String(options.lyricsToken || "").trim()));
      }).slice(-8).map(plan => ({id: plan.id, queuedAt: plan.queuedAt, key: plan.key, kind: plan.kind,
        payload: plan.kind === "caption" ? {url: plan.payload.url, target: plan.payload.target}
          : {videoId: plan.payload.videoId, target: plan.payload.target}}));
    } catch (_) { return []; }
  }
  function savePending(plans) {
    try { return $persistentStore.write(plans.length ? JSON.stringify(plans.slice(-8)) : null, PENDING) !== false; }
    catch (_) { return false; }
  }
  function removePending(plan) {
    savePending(pendingPlans(false).filter(item => item.id !== plan.id));
  }
  function kickBackground(force = false) {
    if (typeof $httpAPI !== "function") return;
    let last;
    try { last = JSON.parse($persistentStore.read(KICK) || "null"); } catch (_) {}
    try {
      if (!force && Number.isFinite(last?.savedAt) && last.savedAt <= Date.now()
        && Date.now() - last.savedAt < 60000) return;
      if ($persistentStore.write(JSON.stringify({savedAt: Date.now()}), KICK) === false) return;
      $httpAPI("POST", "v1/scripting/cron/evaluate", {script_name: "youtube.prewarm.background"}, () => {});
    } catch (_) {}
  }
  function queuePlans(plans) {
    if (!plans.length) return;
    const queued = pendingPlans(false);
    let added = false;
    for (const plan of plans) {
      if (queued.some(item => item.key === plan.key)) continue;
      queued.push({id: `${runId}:${queued.length}`, queuedAt: Date.now(), key: plan.key, kind: plan.kind,
        payload: plan.kind === "caption" ? {url: plan.payload.url, target: plan.payload.target}
          : {videoId: plan.payload.videoId, target: plan.payload.target}});
      added = true;
    }
    if (added && !savePending(queued)) return;
    if (added && options.debug) console.log(`YouTube prewarm: queued ${Math.min(8, queued.length)} background jobs`);
    const retry = plans.some(plan => {
      try {
        const saved = JSON.parse($persistentStore.read(plan.key) || "null");
        return Number.isFinite(saved?.savedAt) && saved.savedAt <= Date.now() && !recent(plan.key);
      } catch (_) { return false; }
    });
    // New work and expired producer attempts retain immediate submission.
    // Repeated packets before the producer starts retry its kick once a minute.
    kickBackground(added || retry);
  }
  function detailsVideoId(fields) {
    const data = fields?.find((field) => field.no === 11 && field.wireType === 2)?.data;
    if (!data) return "";
    let position = 0;
    const read = () => {
      let value = 0, multiplier = 1, count = 0;
      while (position < data.length && count++ < 5) {
        const byte = data[position++]; value += (byte & 127) * multiplier;
        if (!(byte & 128)) return value;
        multiplier *= 128;
      }
      throw new Error("Invalid details");
    };
    try {
      if (read() !== data.length - position || read() !== 10 || read() !== 11 || position + 11 > data.length) return "";
      const id = String.fromCharCode(...data.slice(position, position + 11));
      return /^[\w-]{11}$/.test(id) ? id : "";
    } catch (_) { return ""; }
  }
  function capture(player, music, unknownFields) {
    if (options.prewarm === false || options.prewarm === "false" || plans.length || !player) return;
    const target = language(options.captionLang);
    const tracks = findTracks(player.captions).filter((track) => typeof track.baseUrl === "string"
      && /^https:\/\/www\.youtube\.com\/api\/timedtext\?/.test(track.baseUrl)
      && !query(track.baseUrl, "tlang") && !query(track.baseUrl, "enhance_tlang"));
    const track = tracks.find((track) => captionTarget(track.languageCode || "").toLowerCase() === captionTarget(target).toLowerCase())
      || tracks.find((track) => track.languageCode === "en") || tracks[0];
    let videoId = track ? query(track.baseUrl, "v") : "";
    if (!/^[\w-]{11}$/.test(videoId)) {
      const tracking = JSON.stringify(player.playbackTracking || {});
      const match = tracking.match(/[?&](?:docid|v)=([\w-]{11})(?:[&"\\]|$)/);
      videoId = match?.[1] || "";
    }
    if (!videoId) videoId = detailsVideoId(unknownFields);
    if (!videoId && /^[\w-]{11}$/.test(player.videoId || "")) videoId = player.videoId;
    if (target && track && captionTarget(track.languageCode || "").toLowerCase() !== captionTarget(target).toLowerCase()) {
      const normalizedTarget = captionTarget(target);
      const identity = JSON.stringify([query(track.baseUrl, "v"), query(track.baseUrl, "lang"), query(track.baseUrl, "kind"), query(track.baseUrl, "name"), normalizedTarget]);
      plans.push({kind: "caption", key: `YouTubeCaption.Prewarm.v1.${fingerprint(identity)}`,
        url: "https://youtube-caption-translate.hmtw47cv7m.workers.dev/caption/prewarm",
        token: String(options.captionToken || "").trim(), payload: {url: track.baseUrl, target: normalizedTarget}});
    }
    const lyricsTarget = language(options.lyricsLang), lyricsToken = String(options.lyricsToken || "").trim();
    if (music && lyricsTarget && /^[\w-]{11}$/.test(videoId) && /^[a-f0-9]{64}$/i.test(lyricsToken)) {
      try { $persistentStore.write(JSON.stringify({videoId, savedAt: Date.now()}), "YouTubeLyrics.Prewarm.Active.v1"); } catch (_) {}
      plans.push({kind: "lyrics", key: `YouTubeLyrics.Prewarm.v1.${videoId}.${lyricsTarget}`,
        url: "https://youtube-lyrics-translate.hmtw47cv7m.workers.dev/lyrics/prewarm",
        token: lyricsToken, payload: {videoId, target: lyricsTarget}});
    }
  }
  globalThis.YouTubePrewarm = {capture, enabled: options.prewarm !== false && options.prewarm !== "false"
    && Boolean(language(options.captionLang) || (language(options.lyricsLang) && /^[a-f0-9]{64}$/i.test(String(options.lyricsToken || "").trim())))};
  $done = (result) => {
    if (finished) return;
    const pending = plans.filter((plan) => !recent(plan.key, background));
    if (!background) {
      if ((globalThis.YouTubePrewarm.deadline || Infinity) > Date.now()) queuePlans(pending);
      finished = true; originalDone(result); return;
    }
    const budget = 5000;
    if (!pending.length || budget < 100) { finished = true; originalDone(result); return; }
    let left = pending.length;
    const trace = (plan, state) => { if (options.debug) console.log(`YouTube ${plan.kind} prewarm: ${state}`); };
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      for (const plan of pending) if (plan.waiting) trace(plan, "submitted-unconfirmed");
      try {
        const lease = JSON.parse($persistentStore.read(LEASE) || "null");
        if (lease?.owner === runId) $persistentStore.write(null, LEASE);
      } catch (_) {}
      const handled = new Set(pending.map(plan => plan.id));
      if (pendingPlans(false).some(plan => !handled.has(plan.id) && !recent(plan.key, true))) kickBackground(true);
      originalDone(result);
    };
    const timer = setTimeout(finish, budget);
    for (const plan of pending) {
      remember(plan.key, {savedAt: Date.now()});
      const headers = {"Content-Type": "application/json"};
      if (/^[\w-]{32,128}$/.test(plan.token) && plan.token !== "paste-token-here") headers.Authorization = `Bearer ${plan.token}`;
      function submit() {
        if (finished) return;
        const record = {savedAt: Date.now(), confirmed: false};
        if (plan.kind === "caption") {
          const source = plan.payload.url;
          record.jobId = identifier({version: 1, track: [query(source, "v"), query(source, "lang"), query(source, "kind"), query(source, "name")],
            target: plan.payload.target, body: plan.payload.body});
          record.sourceProvided = typeof plan.payload.body === "string";
        }
        remember(plan.key, record);
        plan.waiting = true;
        try {
          $httpClient.post({url: plan.url, headers, body: JSON.stringify(plan.payload), timeout: 3}, (error, response, body) => {
          if (finished) return;
          plan.waiting = false;
          let accepted = false;
          if (!error && Number(response?.status ?? response?.statusCode) === 202) {
            try {
              const data = JSON.parse(body);
              if (/^[a-f0-9]{64}$/.test(data.jobId || "")) {
                remember(plan.key, {...record, jobId: data.jobId, confirmed: true}); accepted = true;
                removePending(plan);
              }
            } catch (_) {}
          }
          trace(plan, error || (!accepted && Number(response?.status ?? response?.statusCode) === 202) ? "submitted-unconfirmed" : accepted ? "accepted"
            : `rejected (HTTP ${response?.status ?? response?.statusCode})`);
          if (!--left) finish();
          });
        } catch (_) { plan.waiting = false; trace(plan, "submitted-unconfirmed"); if (!--left) finish(); }
      }
      if (plan.kind === "lyrics") { prefetchLyrics(plan, budget, submit); continue; }
      if (plan.kind !== "caption" || typeof $httpClient.get !== "function") { submit(); continue; }
      try {
        const route = JSON.parse($persistentStore.read(sourceRoute(plan.payload.url)) || "null");
        if (route?.workerUntil > Date.now()) { trace(plan, "source: worker"); submit(); continue; }
      } catch (_) {}
      // A bounded local source fetch also handles URLs that cannot be fetched from Cloudflare's IP.
      // Only subtitle text is uploaded; no YouTube cookies or authorization headers leave the device.
      let sourceSettled = false;
      const sourceTimer = setTimeout(() => { if (!sourceSettled) { sourceSettled = true; submit(); } }, 300);
      try {
        const sourceHeaders = {Accept: "text/xml"};
        const requestHeaders = typeof $request === "object" ? $request?.headers : null;
        const agent = requestHeaders?.["User-Agent"] || requestHeaders?.["user-agent"];
        if (agent) sourceHeaders["User-Agent"] = agent;
        const sourceUrl = plan.payload.url.replace(/([?&])fmt=[^&#]*&?/g, "$1").replace(/[?&]$/, "") + "&fmt=srv3";
        $httpClient.get({url: sourceUrl, headers: sourceHeaders, timeout: 0.3}, (error, response, body) => {
          if (sourceSettled || finished) return;
          sourceSettled = true; clearTimeout(sourceTimer);
          if (!error && Number(response?.status ?? response?.statusCode) === 200 && typeof body === "string"
            && body.length <= 350000 && /<timedtext\b/.test(body)) plan.payload.body = body;
          submit();
        });
      } catch (_) { sourceSettled = true; clearTimeout(sourceTimer); submit(); }
    }
  };
  if (background) {
    const queued = pendingPlans().filter(plan => !recent(plan.key, true));
    if (!queued.length) {
      const remaining = options.prewarm === false || options.prewarm === "false" ? []
        : pendingPlans(false).filter(plan => !recent(plan.key, true));
      if ($persistentStore.read(PENDING) !== null) savePending(remaining);
      finished = true; originalDone({}); return;
    }
    let lease;
    try { lease = JSON.parse($persistentStore.read(LEASE) || "null"); } catch (_) {}
    try {
      if (Number.isFinite(lease?.until) && lease.until > Date.now() && lease.until <= Date.now() + 8000) {
        finished = true; originalDone({}); return;
      }
      if ($persistentStore.write(JSON.stringify({owner: runId, until: Date.now() + 8000}), LEASE) === false) throw Error("lease unavailable");
    } catch (_) { finished = true; originalDone({}); return; }
    plans.push(...queued.map(plan => ({...plan,
      url: plan.kind === "caption" ? "https://youtube-caption-translate.hmtw47cv7m.workers.dev/caption/prewarm"
        : "https://youtube-lyrics-translate.hmtw47cv7m.workers.dev/lyrics/prewarm",
      token: String(plan.kind === "caption" ? options.captionToken : options.lyricsToken).trim()})));
    $done({});
  }
})();
