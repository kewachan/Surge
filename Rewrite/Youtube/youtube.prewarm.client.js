// Playback-time prewarm bootstrap. Embedded into youtube.response.js by the build helper.
(() => {
  const options = {captionLang: "off", captionToken: "", lyricsLang: "off", lyricsToken: "", prewarm: true, debug: false};
  try {
    if (typeof $argument === "string" && !$argument.includes("{{{")) Object.assign(options, JSON.parse($argument));
    else if (typeof $argument === "object" && $argument) Object.assign(options, $argument);
  } catch (_) {}
  const plans = [];
  const INDEX = "YouTubeTranslation.PrewarmIndex.v1";
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
  function findTracks(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8) return [];
    if (Array.isArray(value.captionTracks)) return value.captionTracks;
    for (const child of Object.values(value)) {
      const found = findTracks(child, depth + 1); if (found.length) return found;
    }
    return [];
  }
  function remember(key, value) {
    try {
      $persistentStore.write(JSON.stringify(value), key);
      const index = JSON.parse($persistentStore.read(INDEX) || "[]");
      const next = (Array.isArray(index) ? index : []).filter((item) => item.key !== key);
      next.push({key});
      while (next.length > 64) $persistentStore.write("", next.shift().key);
      $persistentStore.write(JSON.stringify(next), INDEX);
    } catch (_) {}
  }
  function recent(key) {
    try {
      const saved = JSON.parse($persistentStore.read(key) || "null");
      return saved && Date.now() - saved.savedAt < (saved.jobId ? 600000 : 15000);
    } catch (_) { return false; }
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
  globalThis.YouTubePrewarm = {capture};
  $done = (result) => {
    if (finished) return;
    const pending = plans.filter((plan) => !recent(plan.key));
    if (!pending.length) { finished = true; originalDone(result); return; }
    let left = pending.length;
    const finish = () => { if (!finished) { finished = true; clearTimeout(timer); originalDone(result); } };
    const timer = setTimeout(finish, 950);
    for (const plan of pending) {
      remember(plan.key, {savedAt: Date.now()});
      const headers = {"Content-Type": "application/json"};
      if (/^[\w-]{32,128}$/.test(plan.token) && plan.token !== "paste-token-here") headers.Authorization = `Bearer ${plan.token}`;
      function submit() {
        if (finished) return;
        try {
          $httpClient.post({url: plan.url, headers, body: JSON.stringify(plan.payload), timeout: 0.9}, (error, response, body) => {
          if (finished) return;
          if (!error && Number(response?.status ?? response?.statusCode) === 202) {
            try {
              const data = JSON.parse(body);
              if (/^[a-f0-9]{64}$/.test(data.jobId || "")) remember(plan.key, {jobId: data.jobId, savedAt: Date.now()});
            } catch (_) {}
          }
          if (options.debug) console.log(`YouTube ${plan.kind} prewarm: ${error ? "unavailable" : response?.status ?? response?.statusCode}`);
          if (!--left) finish();
          });
        } catch (_) { if (!--left) finish(); }
      }
      if (plan.kind !== "caption" || typeof $httpClient.get !== "function") { submit(); continue; }
      // A bounded local source fetch also handles URLs that cannot be fetched from Cloudflare's IP.
      // Only subtitle text is uploaded; no YouTube cookies or authorization headers leave the device.
      let sourceSettled = false;
      const sourceTimer = setTimeout(() => { if (!sourceSettled) { sourceSettled = true; submit(); } }, 300);
      try {
        const sourceHeaders = {Accept: "text/xml"};
        const agent = $request?.headers?.["User-Agent"] || $request?.headers?.["user-agent"];
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
})();
