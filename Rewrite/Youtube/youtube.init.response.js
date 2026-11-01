// BEGIN YOUTUBE PREWARM BOOTSTRAP
// Playback-time prewarm bootstrap. Embedded into both response scripts by the build helper.
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
    const sourceMs = Math.min(700, Math.max(0, budget - 150));
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
      const interval = key.startsWith("YouTubeLyrics.") ? 60000 : 600000;
      return saved && Date.now() - saved.savedAt < (saved.jobId && saved.confirmed !== false ? interval : 15000);
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
    const pending = plans.filter((plan) => !recent(plan.key));
    const budget = Math.max(0, Math.min(950, (globalThis.YouTubePrewarm.deadline || Infinity) - Date.now()));
    if (!pending.length || budget < 100) { finished = true; originalDone(result); return; }
    let left = pending.length;
    const trace = (plan, state) => { if (options.debug) console.log(`YouTube ${plan.kind} prewarm: ${state}`); };
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      for (const plan of pending) if (plan.waiting) trace(plan, "submitted-unconfirmed");
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
          $httpClient.post({url: plan.url, headers, body: JSON.stringify(plan.payload), timeout: 0.9}, (error, response, body) => {
          if (finished) return;
          plan.waiting = false;
          let accepted = false;
          if (!error && Number(response?.status ?? response?.statusCode) === 202) {
            try {
              const data = JSON.parse(body);
              if (/^[a-f0-9]{64}$/.test(data.jobId || "")) {
                remember(plan.key, {...record, jobId: data.jobId, confirmed: true}); accepted = true;
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

// END YOUTUBE PREWARM BOOTSTRAP
// Build: 2026-11-01 — Music keeps Google playback on its original route.
(function () {
  "use strict";

  function concatBytes(...chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }


  function equalBytes(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    return difference === 0;
  }


  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }


  function decodeBase64(value) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = Object.create(null);
    for (let index = 0; index < alphabet.length; index++) lookup[alphabet[index]] = index;
    const input = String(value).replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
    const output = [];
    let buffer = 0;
    let bits = 0;
    for (const character of input) {
      if (character === "=") break;
      const decoded = lookup[character];
      if (decoded === undefined) throw new Error("Invalid base64 client key");
      buffer = (buffer << 6) | decoded;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output.push((buffer >>> bits) & 0xff);
      }
    }
    return new Uint8Array(output);
  }


  function readProtoVarint(bytes, offset) {
    const start = offset;
    let value = 0;
    let multiplier = 1;
    for (let count = 0; count < 10 && offset < bytes.length; count++) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return { value, start, end: offset };
      multiplier *= 128;
    }
    throw new Error(`Invalid protobuf varint at ${start}`);
  }


  function parseProto(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
      const start = offset;
      const tag = readProtoVarint(bytes, offset);
      offset = tag.end;
      const no = Math.floor(tag.value / 8);
      const wire = tag.value & 7;
      if (no < 1) throw new Error("Invalid protobuf field number");
      let value;
      if (wire === 0) {
        value = readProtoVarint(bytes, offset);
        offset = value.end;
      } else if (wire === 1) {
        offset += 8;
      } else if (wire === 2) {
        const length = readProtoVarint(bytes, offset);
        offset = length.end;
        const end = offset + length.value;
        if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error(`Truncated protobuf field ${no}`);
        value = bytes.subarray(offset, end);
        offset = end;
      } else if (wire === 5) {
        offset += 4;
      } else {
        throw new Error(`Unsupported protobuf wire type ${wire}`);
      }
      if (offset > bytes.length) throw new Error(`Truncated protobuf field ${no}`);
      fields.push({ no, wire, value, raw: bytes.subarray(start, offset) });
    }
    return fields;
  }


  function firstProtoField(fields, no, wire) {
    return fields.find((field) => field.no === no && field.wire === wire);
  }


  function readUmpVarint(bytes, offset) {
    if (offset >= bytes.length) throw new Error("Truncated UMP varint");
    const first = bytes[offset];
    const size = first < 0x80 ? 1 : first < 0xc0 ? 2 : first < 0xe0 ? 3 : first < 0xf0 ? 4 : 5;
    if (offset + size > bytes.length) throw new Error("Truncated UMP varint");
    let value;
    if (size === 1) value = first;
    else if (size === 2) value = (first & 0x3f) + 64 * bytes[offset + 1];
    else if (size === 3) value = (first & 0x1f) + 32 * (bytes[offset + 1] + 256 * bytes[offset + 2]);
    else if (size === 4) value = (first & 0x0f) + 16 * (bytes[offset + 1] + 256 * (bytes[offset + 2] + 256 * bytes[offset + 3]));
    else value = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, true);
    return { value, end: offset + size };
  }


  function parseUmp(bytes) {
    const parts = [];
    let offset = 0;
    while (offset < bytes.length) {
      const start = offset;
      const type = readUmpVarint(bytes, offset);
      const length = readUmpVarint(bytes, type.end);
      const end = length.end + length.value;
      if (end > bytes.length) throw new Error("Truncated UMP part");
      parts.push({ type: type.value, data: bytes.subarray(length.end, end), raw: bytes.subarray(start, end) });
      offset = end;
    }
    return parts;
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

  function hmacSha256(key, message) {
    let normalizedKey = key.length > 64 ? sha256(key) : key;
    if (normalizedKey.length < 64) {
      const padded = new Uint8Array(64);
      padded.set(normalizedKey);
      normalizedKey = padded;
    }
    const innerPad = new Uint8Array(64);
    const outerPad = new Uint8Array(64);
    for (let index = 0; index < 64; index++) {
      innerPad[index] = normalizedKey[index] ^ 0x36;
      outerPad[index] = normalizedKey[index] ^ 0x5c;
    }
    return sha256(concatBytes(outerPad, sha256(concatBytes(innerPad, message))));
  }

  const KEY_RING_PREFIX = "YouTubePlaybackKeys.v2.";
  const MAX_BYTES = 24 * 1024 * 1024;
  const WORKER = "https://youtube-init.hmtw47cv7m.workers.dev/transform";

  function argumentsMap() {
    let values = {};
    try {
      values = typeof $argument === "string" ? JSON.parse($argument) :
        typeof $argument === "object" && $argument ? $argument : {};
    } catch (_) {}
    const captionLang = typeof values.captionLang === "string" &&
      /^(?:off|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(values.captionLang) ? values.captionLang : "off";
    return { captionLang, debug: values.debug === true };
  }

  function transformMetadata(url, bytes) {
    return new Promise((resolve, reject) => {
      $httpClient.post({
        url, method: "POST", headers: { "Content-Type": "application/vnd.yt-ump" },
        body: bytes, timeout: 8, policy: "DIRECT", "binary-mode": true,
        "auto-redirect": false, "auto-cookie": false
      }, (error, response, data) => {
        if (error) return reject(new Error("Transform failed"));
        resolve({ statusCode: Number(response && response.status), headers: response && response.headers, bodyBytes: data });
      });
    });
  }

  function header(headers, name) {
    const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name);
    return key === undefined ? "" : headers[key];
  }

  function readState(platform) {
    try { return JSON.parse($persistentStore.read(KEY_RING_PREFIX + platform) || "{}"); }
    catch (_) { return {}; }
  }

  function candidateKeys(platform) {
    const state = readState(platform), values = [];
    for (const entry of (Array.isArray(state.entries) ? state.entries : []).slice(0, 8)) {
      if (entry && entry.expiresAt > Date.now()) values.push(entry.clientKey);
    }
    try {
      const config = JSON.parse($persistentStore.read("YouTubeConfig") || "{}");
      if (config[platform]?.clientKey) values.push(config[platform].clientKey);
    } catch (_) {}
    const keys = [];
    for (const value of values) {
      try {
        const bytes = decodeBase64(value);
        if (bytes.length === 32 && !keys.some(key => equalBytes(key.bytes, bytes))) keys.push({ value, bytes });
      } catch (_) {}
    }
    return keys.slice(0, 8);
  }

  function authenticatedKey(parts, candidates) {
    let encrypted = false;
    for (const part of parts) {
      if (part.type === 10) {
        encrypted = firstProtoField(parseProto(part.data), 1, 0)?.value?.value === 25;
      } else if (part.type === 11 && encrypted) {
        const fields = parseProto(part.data);
        const ciphertext = firstProtoField(fields, 1, 2)?.value;
        const signature = firstProtoField(fields, 2, 2)?.value;
        const iv = firstProtoField(fields, 3, 2)?.value;
        if (!ciphertext || signature?.length !== 32 || iv?.length !== 16) throw new Error("Invalid encrypted part");
        const signed = concatBytes(ciphertext, iv);
        return candidates.find(key => equalBytes(signature, hmacSha256(key.bytes.subarray(16), signed))) || null;
      }
    }
    return undefined;
  }

  function validEncryptedRewrite(original, replacement, key) {
    const before = parseProto(original), after = parseProto(replacement);
    const controls = fields => fields.filter(field => ![1, 2, 3].includes(field.no));
    const oldControls = controls(before), newControls = controls(after);
    if (oldControls.length !== newControls.length || oldControls.some((field, index) =>
      !equalBytes(field.raw, newControls[index].raw))) return false;
    if ([1, 2, 3].some(number => after.filter(field => field.no === number && field.wire === 2).length !== 1 ||
      after.filter(field => field.no === number).length !== 1)) return false;
    const ciphertext = firstProtoField(after, 1, 2)?.value;
    const signature = firstProtoField(after, 2, 2)?.value;
    const iv = firstProtoField(after, 3, 2)?.value;
    return ciphertext?.length > 0 && signature?.length === 32 && iv?.length === 16 &&
      equalBytes(signature, hmacSha256(key.bytes.subarray(16), concatBytes(ciphertext, iv)));
  }

  let completed = false, deadline;
  function finish(value) {
    if (completed) return;
    completed = true;
    if (deadline && typeof clearTimeout === "function") clearTimeout(deadline);
    $done(value);
  }

  try {
    if (!String(header($request.headers, "user-agent")).toLowerCase().includes("youtubemusic") ||
        !/^https?:\/\/[\w-]+\.googlevideo\.com\/(?:initplayback|videoplayback)\?/.test($request.url || "")) return finish({});
    const input = toBytes($response.body), options = argumentsMap();
    if (Number($response.status ?? $response.statusCode) !== 200 || !input?.length || input.length > MAX_BYTES ||
        !String(header($response.headers, "content-type")).toLowerCase().includes("application/vnd.yt-ump")) return finish({});
    const platform = String(header($request.headers, "user-agent")).toLowerCase().includes("music") ? "youtubeMusic" : "youtube";
    const parts = parseUmp(input), key = authenticatedKey(parts, candidateKeys(platform));
    if (key === undefined) return finish({});
    if (!key) {
      const state = readState(platform);
      state.refreshNeeded = true;
      $persistentStore.write(JSON.stringify(state), KEY_RING_PREFIX + platform);
      console.log("YouTube initplayback: playback key refresh requested");
      return finish({});
    }
    const state = readState(platform);
    if (state.refreshNeeded) {
      state.refreshNeeded = false;
      $persistentStore.write(JSON.stringify(state), KEY_RING_PREFIX + platform);
    }
    const selected = [], slots = [];
    let encryptedHeader = -1;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (part.type === 10) encryptedHeader = firstProtoField(parseProto(part.data), 1, 0)?.value?.value === 25 ? index : -1;
      else if (part.type === 11 && encryptedHeader >= 0) {
        selected.push(parts[encryptedHeader], part); slots.push(index); encryptedHeader = -1;
      }
    }
    const metadata = concatBytes(...selected.map(part => part.raw));
    if (globalThis.YouTubePrewarm) globalThis.YouTubePrewarm.deadline = Date.now() + 8000;
    deadline = setTimeout(() => {
      console.log("YouTube initplayback: transform timeout; original response kept");
      finish({});
    }, 8000);
    transformMetadata(WORKER + "?ck=" + encodeURIComponent(key.value) +
      "&captionLang=" + encodeURIComponent(options.captionLang) +
      (globalThis.YouTubePrewarm?.enabled ? "&prewarm=1" : ""), metadata).then(response => {
      if (completed) return;
      const output = toBytes(response.bodyBytes);
      const result = String(header(response.headers, "x-youtube-adblock"));
      if (response.statusCode !== 200 || !output?.length || output.length > MAX_BYTES || !/^removed-\d+$/.test(result)) {
        console.log("YouTube initplayback: invalid transform response; original response kept");
        return finish({});
      }
      const transformed = parseUmp(output);
      if (transformed.length !== selected.length || transformed.some((part, index) => part.type !== selected[index].type ||
          (part.type === 11 ? !validEncryptedRewrite(selected[index].data, part.data, key)
            : !equalBytes(part.data, selected[index].data)))) throw new Error("UMP structure changed");
      try {
        const hint = String(header(response.headers, "x-youtube-player-prewarm"));
        if (hint && hint.length <= 20000 && globalThis.YouTubePrewarm) {
          const player = JSON.parse(String.fromCharCode(...decodeBase64(hint)));
          globalThis.YouTubePrewarm.capture(player, true);
        }
      } catch (_) {}
      if (options.debug) console.log("YouTube initplayback: " + result);
      if (equalBytes(metadata, output)) return finish({});
      const chunks = parts.map(part => part.raw);
      slots.forEach((index, slot) => { chunks[index] = transformed[slot * 2 + 1].raw; });
      const rewritten = concatBytes(...chunks);
      finish({ body: rewritten });
    }).catch(() => {
      console.log("YouTube initplayback: transform failed; original response kept");
      finish({});
    });
  } catch (_) {
    console.log("YouTube initplayback: unsupported response; original response kept");
    finish({});
  }
})();
