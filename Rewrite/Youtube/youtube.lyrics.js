// Add bilingual YouTube Music lyrics using the dedicated lyrics Worker.
// Only lyric text and the requested language are sent to the Worker.

(() => {
  const WORKER_ENDPOINT = "https://youtube-lyrics-translate.hmtw47cv7m.workers.dev/lyrics";
  const LYRICS_RENDERER_FIELD = 465160965;
  const TRANSLATE_CONTROL_FIELD = 24;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_LIMIT = 64;
  const CACHE_INDEX_KEY = "YouTubeLyrics.CacheIndex.v2";
  const MAX_BATCH_ITEMS = 12;
  const MAX_BATCH_TOTAL_CHARS = 600;
  const CONCURRENCY = 3;
  const RESPONSE_BUDGET_MS = 9000;
  const TRANSLATE_TIMEOUT_SECONDS = 110;
  const MAX_BUSY_RETRIES = 0;
  const TEXT_ENCODER = new TextEncoder();
  const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

  function settings() {
    const output = { lyricsLang: "zh-Hant", lyricsToken: "", debug: false };
    try {
      if (typeof $argument === "string" && !$argument.includes("{{{")) {
        Object.assign(output, JSON.parse($argument));
      } else if (typeof $argument === "object" && $argument) {
        Object.assign(output, $argument);
      }
    } catch (_) {}
    return output;
  }

  function normalizeAccessToken(value) {
    const token = String(value || "").trim();
    return /^[a-f0-9]{64}$/i.test(token) ? token : "";
  }

  function normalizeLanguage(value) {
    const language = String(value || "").trim();
    if (!language || language.toLowerCase() === "off" || language.length > 32) return "off";
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) return "off";
    return {
      "zh-hant": "zh-Hant",
      "zh-hans": "zh-Hans",
      "zh-tw": "zh-TW",
      "zh-cn": "zh-CN",
    }[language.toLowerCase()] || language;
  }

  function responseBytes() {
    const body = $response?.bodyBytes ?? $response?.body;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return null;
  }

  function readVarint(bytes, position, limit) {
    let value = 0;
    let multiplier = 1;
    const start = position;
    while (position < limit && position - start < 10) {
      const byte = bytes[position++];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return [value, position];
      multiplier *= 128;
    }
    throw new Error("Invalid protobuf varint");
  }

  function encodeVarint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid protobuf value");
    const output = [];
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value) byte |= 0x80;
      output.push(byte);
    } while (value);
    return Uint8Array.from(output);
  }

  function parseMessage(bytes) {
    const fields = [];
    let position = 0;
    try {
      while (position < bytes.length) {
        const fieldStart = position;
        let tag;
        [tag, position] = readVarint(bytes, position, bytes.length);
        const number = Math.floor(tag / 8);
        const wireType = tag & 7;
        if (number < 1 || wireType === 3 || wireType === 4 || wireType > 5) return null;

        let dataStart = position;
        let dataEnd = position;
        if (wireType === 0) {
          [, position] = readVarint(bytes, position, bytes.length);
          dataEnd = position;
        } else if (wireType === 1) {
          position += 8;
          dataEnd = position;
        } else if (wireType === 2) {
          let length;
          [length, position] = readVarint(bytes, position, bytes.length);
          dataStart = position;
          position += length;
          dataEnd = position;
        } else {
          position += 4;
          dataEnd = position;
        }
        if (position > bytes.length) return null;
        fields.push({ number, wireType, fieldStart, fieldEnd: position, dataStart, dataEnd });
      }
    } catch (_) {
      return null;
    }
    return position === bytes.length ? fields : null;
  }

  function join(chunks) {
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  function encodeField(number, data) {
    return join([encodeVarint(number * 8 + 2), encodeVarint(data.length), data]);
  }

  function rawField(bytes, field) {
    return bytes.subarray(field.fieldStart, field.fieldEnd);
  }

  function fieldData(bytes, field) {
    return bytes.subarray(field.dataStart, field.dataEnd);
  }

  function decodeText(bytes) {
    try {
      const text = TEXT_DECODER.decode(bytes);
      return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? "" : text;
    } catch (_) {
      return "";
    }
  }

  function lyricList(rendererBytes) {
    const rendererFields = parseMessage(rendererBytes);
    if (!rendererFields) return null;
    const listField = rendererFields.find((field) => field.number === 4 && field.wireType === 2);
    if (!listField) return null;
    const listBytes = fieldData(rendererBytes, listField);
    const listFields = parseMessage(listBytes);
    if (!listFields) return null;

    const lines = [];
    for (const itemField of listFields) {
      if (itemField.number !== 1 || itemField.wireType !== 2) continue;
      const itemBytes = fieldData(listBytes, itemField);
      const itemFields = parseMessage(itemBytes);
      if (!itemFields?.some((field) => field.number === 2 && field.wireType === 2)) continue;
      const textField = itemFields.find((field) => field.number === 1 && field.wireType === 2);
      if (!textField) continue;
      const text = decodeText(fieldData(itemBytes, textField)).trim();
      if (text && text !== "♪") lines.push(text);
    }
    return lines.length >= 2 ? { rendererFields, listField, listBytes, listFields, lines } : null;
  }

  function findLyrics(bytes, depth = 0) {
    if (depth > 14) return null;
    const fields = parseMessage(bytes);
    if (!fields) return null;
    for (const field of fields) {
      if (field.wireType !== 2) continue;
      const data = fieldData(bytes, field);
      if (field.number === LYRICS_RENDERER_FIELD) {
        const list = lyricList(data);
        if (list) return list.lines;
      }
      if (data.length >= 4) {
        const nested = findLyrics(data, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  }

  function rewriteLyricsRenderer(rendererBytes, translatedByOriginal, hideTranslateControl) {
    const lyrics = lyricList(rendererBytes);
    if (!lyrics) return [rendererBytes, false];
    let listChanged = false;
    const listChunks = [];

    for (const itemField of lyrics.listFields) {
      if (hideTranslateControl && itemField.number === TRANSLATE_CONTROL_FIELD && itemField.wireType === 2) {
        listChanged = true;
        continue;
      }
      if (itemField.number !== 1 || itemField.wireType !== 2) {
        listChunks.push(rawField(lyrics.listBytes, itemField));
        continue;
      }
      const itemBytes = fieldData(lyrics.listBytes, itemField);
      const itemFields = parseMessage(itemBytes);
      const textField = itemFields?.find((field) => field.number === 1 && field.wireType === 2);
      if (!textField) {
        listChunks.push(rawField(lyrics.listBytes, itemField));
        continue;
      }
      const original = decodeText(fieldData(itemBytes, textField)).trim();
      const translated = translatedByOriginal.get(original)?.trim();
      if (!translated || translated === original || original === "♪") {
        listChunks.push(rawField(lyrics.listBytes, itemField));
        continue;
      }

      const bilingual = TEXT_ENCODER.encode(`${original}\n${translated}`);
      const itemChunks = itemFields.map((field) => (
        field === textField ? encodeField(field.number, bilingual) : rawField(itemBytes, field)
      ));
      listChunks.push(encodeField(itemField.number, join(itemChunks)));
      listChanged = true;
    }

    if (!listChanged) return [rendererBytes, false];
    const rewrittenList = join(listChunks);
    const rendererChunks = lyrics.rendererFields.map((field) => (
      field === lyrics.listField ? encodeField(field.number, rewrittenList) : rawField(rendererBytes, field)
    ));
    return [join(rendererChunks), true];
  }

  function rewriteNested(bytes, translatedByOriginal, depth = 0, hideTranslateControl = false) {
    if (depth > 14) return [bytes, false];
    const fields = parseMessage(bytes);
    if (!fields) return [bytes, false];
    let changed = false;
    const chunks = [];

    for (const field of fields) {
      if (field.wireType !== 2) {
        chunks.push(rawField(bytes, field));
        continue;
      }
      const data = fieldData(bytes, field);
      let rewritten = data;
      let fieldChanged = false;
      if (field.number === LYRICS_RENDERER_FIELD) {
        [rewritten, fieldChanged] = rewriteLyricsRenderer(data, translatedByOriginal, hideTranslateControl);
      }
      if (!fieldChanged && data.length >= 4) {
        [rewritten, fieldChanged] = rewriteNested(data, translatedByOriginal, depth + 1, hideTranslateControl);
      }
      if (fieldChanged) {
        chunks.push(encodeField(field.number, rewritten));
        changed = true;
      } else {
        chunks.push(rawField(bytes, field));
      }
    }
    return changed ? [join(chunks), true] : [bytes, false];
  }

  function cacheKey(lines, target) {
    let hash = 2166136261;
    const value = `${target}|${lines.join("\u001f")}`;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `YouTubeLyrics.v2.${(hash >>> 0).toString(16)}`;
  }

  function buildTranslationBatches(lines) {
    const batches = [];
    let batch = [];
    let characters = 0;
    for (const line of lines) {
      if (batch.length && (batch.length >= MAX_BATCH_ITEMS || characters + line.length > MAX_BATCH_TOTAL_CHARS)) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push(line);
      characters += line.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function readCache(key, expectedLength) {
    if (typeof $persistentStore === "undefined") return null;
    try {
      const cached = JSON.parse($persistentStore.read(key) || "null");
      if (
        cached && Array.isArray(cached.translations)
        && cached.translations.length === expectedLength
        && Date.now() - Number(cached.savedAt || 0) < CACHE_TTL_MS
      ) return cached.translations;
      if (cached) $persistentStore.write("", key);
    } catch (_) {}
    return null;
  }

  function writeCache(key, translations) {
    if (typeof $persistentStore === "undefined") return;
    try {
      const savedAt = Date.now();
      $persistentStore.write(JSON.stringify({ savedAt, translations }), key);
      const stored = JSON.parse($persistentStore.read(CACHE_INDEX_KEY) || "[]");
      const index = (Array.isArray(stored) ? stored : [])
        .filter((item) => item?.key && item.key !== key && savedAt - Number(item.savedAt || 0) < CACHE_TTL_MS);
      index.push({ key, savedAt });
      while (index.length > CACHE_LIMIT) {
        const expired = index.shift();
        if (expired?.key) $persistentStore.write("", expired.key);
      }
      $persistentStore.write(JSON.stringify(index), CACHE_INDEX_KEY);
    } catch (_) {}
  }

  function requestTranslations(lines, target, timeoutSeconds, accessToken) {
    const payload = JSON.stringify({ purpose: "lyrics", texts: lines, source: "auto", target });
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (typeof $httpClient !== "undefined") {
      return new Promise((resolve, reject) => {
        $httpClient.post({
          url: WORKER_ENDPOINT,
          timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
          headers,
          body: payload,
        }, (error, response, body) => {
          if (error) return reject(error);
          try {
            const status = response.status || response.statusCode;
            if (status !== 200) {
              const statusError = new Error(`Worker status ${status}`);
              statusError.status = status;
              throw statusError;
            }
            const result = JSON.parse(body);
            if (!Array.isArray(result?.translations) || result.translations.length !== lines.length) {
              throw new Error("Invalid Worker translation response");
            }
            resolve(result.translations.map((line) => String(line || "")));
          } catch (parseError) {
            reject(parseError);
          }
        });
      });
    }
    if (typeof $task !== "undefined") {
      return $task.fetch({
        url: WORKER_ENDPOINT,
        method: "POST",
        timeout: timeoutSeconds,
        headers,
        body: payload,
      }).then((response) => {
        if (response.statusCode !== 200) {
          const statusError = new Error(`Worker status ${response.statusCode}`);
          statusError.status = response.statusCode;
          throw statusError;
        }
        const result = JSON.parse(response.body);
        if (!Array.isArray(result?.translations) || result.translations.length !== lines.length) {
          throw new Error("Invalid Worker translation response");
        }
        return result.translations.map((line) => String(line || ""));
      });
    }
    return Promise.reject(new Error("No HTTP client available"));
  }

  async function fetchTranslations(lines, target, deadline, accessToken) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lastError || new Error("Lyrics translation time budget exhausted");
      const timeout = Math.max(1, Math.min(TRANSLATE_TIMEOUT_SECONDS, Math.ceil(remaining / 1000)));
      try {
        return await requestTranslations(lines, target, timeout, accessToken);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_BUSY_RETRIES || Number(error?.status) !== 429) break;
        const delay = 5000;
        if (Date.now() + delay >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError || new Error("Lyrics translation failed");
  }

  async function main() {
    const options = settings();
    const target = normalizeLanguage(options.lyricsLang);
    const accessToken = normalizeAccessToken(options.lyricsToken);
    const input = responseBytes();
    if (target === "off" || !input) return $done({});
    if (!accessToken) {
      if (options.debug) console.log("YouTube lyrics translation skipped: access token is missing or invalid");
      return $done({});
    }

    const [inputWithoutControl, controlChanged] = rewriteNested(input, new Map(), 0, true);
    const lines = findLyrics(inputWithoutControl);
    if (!lines) return $done(controlChanged ? { body: inputWithoutControl } : {});
    const uniqueLines = [...new Set(lines)];
    try {
      const translatedByOriginal = new Map();
      const deadline = Date.now() + RESPONSE_BUDGET_MS;
      const batches = buildTranslationBatches(uniqueLines);
      let cursor = 0;
      async function worker() {
        while (cursor < batches.length && Date.now() < deadline) {
          const batch = batches[cursor++];
          const key = cacheKey(batch, target);
          let translations = readCache(key, batch.length);
          if (!translations) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            try {
              translations = await fetchTranslations(batch, target, deadline, accessToken);
              writeCache(key, translations);
            } catch (error) {
              console.log(`YouTube lyrics translation batch failed: ${String(error)}`);
              continue;
            }
          }
          batch.forEach((line, index) => translatedByOriginal.set(line, translations[index]));
        }
      }
      const work = Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
      let timer;
      await Promise.race([
        work,
        new Promise((resolve) => { timer = setTimeout(resolve, RESPONSE_BUDGET_MS); }),
      ]);
      if (timer) clearTimeout(timer);
      if (translatedByOriginal.size !== uniqueLines.length) {
        throw new Error(`Incomplete lyrics translation (${translatedByOriginal.size}/${uniqueLines.length})`);
      }

      const [output, translated] = rewriteNested(inputWithoutControl, translatedByOriginal);
      const changed = controlChanged || translated;
      if (options.debug) console.log(`YouTube lyrics: ${translated ? "translated" : "unchanged"}; translate control ${controlChanged ? "hidden" : "absent"} (${translatedByOriginal.size}/${uniqueLines.length} unique lines)`);
      return $done(changed ? { body: output } : {});
    } catch (error) {
      console.log(`YouTube lyrics translation failed: ${String(error)}`);
      return $done(controlChanged ? { body: inputWithoutControl } : {});
    }
  }

  main().catch((error) => {
    console.log(`YouTube lyrics translation failed: ${String(error)}`);
    $done({});
  });
})();
