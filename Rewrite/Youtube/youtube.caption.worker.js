import { DurableObject } from "cloudflare:workers";

const JOBS_PATH = "/caption/jobs";
const WORKER_BUILD = "caption-queue-v2";
const GOOGLE_TRANSLATE_ATTEMPTS = [
  ["https://translate.google.com/translate_a/single", "dict-chrome-ex"],
  ["https://translate.googleapis.com/translate_a/single", "dict-chrome-ex"],
  ["https://translate.googleapis.com/translate_a/single", "gtx"],
];
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ITEMS = 5000;
const MAX_LINE_CHARS = 1000;
const MAX_TOTAL_CHARS = 500000;
const MAX_BATCH_ITEMS = 120;
const MAX_BATCH_ENCODED_QUERY_CHARS = 5500;
const MAX_SEND_BATCH_MESSAGES = 100;
const MAX_SEND_BATCH_BYTES = 220 * 1024;
const GOOGLE_TRANSLATE_TIMEOUT_MS = 8000;
const MAX_QUEUE_ATTEMPTS = 4;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_RATE_WINDOW_MS = 60 * 1000;
const PUBLIC_RATE_LIMIT = 12;
const ACCESS_TOKEN_PREFIX = "Bearer ";
const MAX_ACCESS_TOKEN_CHARS = 128;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function captionJobId(payload) {
  const canonical = JSON.stringify([payload.source, payload.target, payload.texts]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(canonical)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function constantTimeEqual(left, right) {
  const leftBytes = TEXT_ENCODER.encode(left);
  const rightBytes = TEXT_ENCODER.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index++) {
    mismatch |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return mismatch === 0;
}

function hasValidAccessToken(request, env) {
  const expected = String(env?.CAPTION_ACCESS_TOKEN || "");
  const authorization = request.headers.get("authorization") || "";
  if (!expected || !authorization.startsWith(ACCESS_TOKEN_PREFIX)) return false;
  const supplied = authorization.slice(ACCESS_TOKEN_PREFIX.length).trim();
  return supplied.length > 0
    && supplied.length <= MAX_ACCESS_TOKEN_CHARS
    && constantTimeEqual(supplied, expected);
}

function normalizeLanguage(value, allowAuto = false) {
  const language = String(value || "").trim();
  if (allowAuto && language.toLowerCase() === "auto") return "auto";
  if (!language || language.length > 32 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) return "";
  return {
    "zh-hant": "zh-TW",
    "zh-hans": "zh-CN",
    "zh-tw": "zh-TW",
    "zh-cn": "zh-CN",
  }[language.toLowerCase()] || language;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-YouTube-Worker-Build": WORKER_BUILD,
      ...extraHeaders,
    },
  });
}

function textResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-YouTube-Worker-Build": WORKER_BUILD,
      ...extraHeaders,
    },
  });
}

function translationSeparator(index) {
  return `\n[[YTC:${index}]]\n`;
}

function translationQuery(texts) {
  return texts.map((text, index) => `${index ? translationSeparator(index) : ""}${text}`).join("");
}

function buildTranslationBatches(texts) {
  const batches = [];
  let batch = [];
  let startIndex = 0;

  function flush() {
    if (!batch.length) return;
    batches.push({ startIndex, texts: batch });
    startIndex += batch.length;
    batch = [];
  }

  for (const text of texts) {
    const candidate = [...batch, text];
    if (
      batch.length
      && (batch.length >= MAX_BATCH_ITEMS
        || encodeURIComponent(translationQuery(candidate)).length > MAX_BATCH_ENCODED_QUERY_CHARS)
    ) {
      flush();
    }
    batch.push(text);
  }
  flush();
  return batches;
}

function splitQueueMessages(messages) {
  const groups = [];
  let group = [];
  let bytes = 0;
  for (const body of messages) {
    const messageBytes = TEXT_ENCODER.encode(JSON.stringify(body)).length;
    if (group.length && (group.length >= MAX_SEND_BATCH_MESSAGES || bytes + messageBytes > MAX_SEND_BATCH_BYTES)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push({ body, contentType: "json" });
    bytes += messageBytes;
  }
  if (group.length) groups.push(group);
  return groups;
}

async function fetchGoogleTranslation(query, source, target) {
  let lastError;
  for (const [endpoint, client] of GOOGLE_TRANSLATE_ATTEMPTS) {
    const body = new URLSearchParams({ client, sl: source, tl: target, dt: "t", q: query });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GOOGLE_TRANSLATE_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://translate.google.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Google Translate status ${response.status}`);
      const result = await response.json();
      if (!Array.isArray(result?.[0])) throw new Error("Invalid Google Translate response");
      return result[0].map((part) => part?.[0] || "").join("");
    } catch (error) {
      lastError = new Error(`${new URL(endpoint).hostname}: ${error?.message || String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("Google Translate unavailable");
}

async function translateGoogleBatch(texts, source, target) {
  const translated = await fetchGoogleTranslation(translationQuery(texts), source, target);
  if (texts.length === 1) return [translated.trim()];
  const parts = translated.split(/\s*\[\[\s*YTC\s*:\s*\d+\s*\]\]\s*/gi);
  if (parts.length === texts.length) return parts.map((part) => part.trim());

  const middle = Math.ceil(texts.length / 2);
  const [left, right] = await Promise.all([
    translateGoogleBatch(texts.slice(0, middle), source, target),
    translateGoogleBatch(texts.slice(middle), source, target),
  ]);
  return [...left, ...right];
}

function jobStub(env, jobId) {
  return env.CAPTION_JOBS.get(env.CAPTION_JOBS.idFromName(jobId));
}

async function initializeJob(env, jobId, itemCount, batchCount) {
  const response = await jobStub(env, jobId).fetch("https://caption-job/internal/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, itemCount, batchCount, createdAt: Date.now() }),
  });
  if (!response.ok) throw new Error(`Job initialization failed with ${response.status}`);
  return response.json();
}

async function readJobStatus(env, jobId) {
  const response = await jobStub(env, jobId).fetch("https://caption-job/internal/status");
  if (!response.ok) return null;
  return response.json();
}

async function resetFailedJob(env, jobId) {
  const response = await jobStub(env, jobId).fetch("https://caption-job/internal/retry", {method: "POST"});
  if (!response.ok) throw new Error(`Job retry reset failed with ${response.status}`);
}

async function allowPublicJob(request, env) {
  const client = request.headers.get("CF-Connecting-IP") || "unknown-client";
  const response = await jobStub(env, `rate:${client}`).fetch("https://caption-job/internal/rate-limit", {
    method: "POST",
  });
  return response.ok;
}

async function failJob(env, jobId, reason) {
  await jobStub(env, jobId).fetch("https://caption-job/internal/fatal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: String(reason || "Unknown failure").slice(0, 300) }),
  });
}

async function readRequestJson(request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json")) throw Object.assign(new Error("JSON Required"), { status: 415 });
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw Object.assign(new Error("Request Too Large"), { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_REQUEST_BYTES) throw Object.assign(new Error("Request Too Large"), { status: 413 });
  try {
    return JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function validateJobPayload(payload) {
  const texts = payload?.texts;
  const source = normalizeLanguage(payload?.source || "auto", true);
  const target = normalizeLanguage(payload?.target, false);
  if (payload?.purpose && payload.purpose !== "captions") throw Object.assign(new Error("Invalid Caption Job"), { status: 400 });
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_ITEMS || !source || !target) {
    throw Object.assign(new Error("Invalid Caption Job"), { status: 400 });
  }

  let totalCharacters = 0;
  const normalizedTexts = [];
  for (const value of texts) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_LINE_CHARS) {
      throw Object.assign(new Error("Invalid Caption Job"), { status: 400 });
    }
    const text = value.trim();
    if (encodeURIComponent(text).length > MAX_BATCH_ENCODED_QUERY_CHARS) {
      throw Object.assign(new Error("Caption Line Too Large"), { status: 413 });
    }
    totalCharacters += text.length;
    if (totalCharacters > MAX_TOTAL_CHARS) throw Object.assign(new Error("Caption Job Too Large"), { status: 413 });
    normalizedTexts.push(text);
  }
  return { texts: normalizedTexts, source, target };
}

async function createJob(request, env) {
  if (!env?.CAPTION_QUEUE || !env?.CAPTION_JOBS) return textResponse("Service Unavailable", 503);
  let payload;
  try {
    payload = validateJobPayload(await readRequestJson(request));
  } catch (error) {
    return textResponse(error?.message || "Invalid Caption Job", Number(error?.status) || 400);
  }

  const batches = buildTranslationBatches(payload.texts);
  const jobId = await captionJobId(payload);
  try {
    const initialized = await initializeJob(env, jobId, payload.texts.length, batches.length);
    if (!initialized.created) {
      const existing = await readJobStatus(env, jobId);
      if (existing?.status === "complete") {
        return jsonResponse({...existing, statusUrl: `${JOBS_PATH}/${jobId}`, reused: true});
      }
      if (existing?.status === "queued" || existing?.status === "processing") {
        return jsonResponse({...existing, statusUrl: `${JOBS_PATH}/${jobId}`, pollAfterMs: 250, reused: true}, 202);
      }
      await resetFailedJob(env, jobId);
    }
    const messages = batches.map((batch, batchIndex) => ({
      jobId,
      batchIndex,
      startIndex: batch.startIndex,
      texts: batch.texts,
      source: payload.source,
      target: payload.target,
    }));
    for (const group of splitQueueMessages(messages)) await env.CAPTION_QUEUE.sendBatch(group);
  } catch (error) {
    console.error("YouTube caption job enqueue failed:", error?.message || String(error));
    try {
      await failJob(env, jobId, error?.message || String(error));
    } catch (statusError) {
      console.error("YouTube caption job failure state could not be saved:", statusError?.message || String(statusError));
    }
    return textResponse("Caption Job Enqueue Failed", 502);
  }

  return jsonResponse({
    jobId,
    status: "queued",
    statusUrl: `${JOBS_PATH}/${jobId}`,
    pollAfterMs: 250,
    itemCount: payload.texts.length,
    batchCount: batches.length,
  }, 202, { Location: `${JOBS_PATH}/${jobId}` });
}

async function getJobStatus(jobId, env) {
  if (!JOB_ID_PATTERN.test(jobId)) return textResponse("Not Found", 404);
  return jobStub(env, jobId).fetch("https://caption-job/internal/status");
}

async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", build: WORKER_BUILD });
    }
    if (!url.pathname.startsWith(JOBS_PATH)) return textResponse("Not Found", 404);
    const authorization = request.headers.get("authorization") || "";
    const authenticated = hasValidAccessToken(request, env);
    if (authorization && !authenticated) {
      return textResponse("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
    }
    if (request.method === "POST" && url.pathname === JOBS_PATH) {
      if (!authenticated && !(await allowPublicJob(request, env))) {
        return textResponse("Too Many Requests", 429, {"Retry-After": "60"});
      }
      return createJob(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith(`${JOBS_PATH}/`)) {
      return getJobStatus(url.pathname.slice(JOBS_PATH.length + 1), env);
    }
    return textResponse("Method Not Allowed", 405, { Allow: "GET, POST" });
  } catch (error) {
    console.error("YouTube caption request failed:", error?.message || String(error));
    return textResponse("Internal Server Error", 500);
  }
}

async function processQueueMessage(message, env) {
  const body = message?.body || {};
  if (
    !JOB_ID_PATTERN.test(String(body.jobId || ""))
    || !Number.isInteger(body.batchIndex) || body.batchIndex < 0
    || !Number.isInteger(body.startIndex) || body.startIndex < 0
    || !Array.isArray(body.texts) || !body.texts.length
  ) {
    console.error("Discarding invalid YouTube caption queue message");
    message.ack();
    return;
  }

  const stub = jobStub(env, body.jobId);
  const existing = await stub.fetch(`https://caption-job/internal/batch/${body.batchIndex}`);
  if (existing.ok) {
    message.ack();
    return;
  }

  try {
    const translations = await translateGoogleBatch(body.texts, body.source, body.target);
    if (translations.length !== body.texts.length || translations.some((text) => !text)) {
      throw new Error("Incomplete Google Translate response");
    }
    const stored = await stub.fetch("https://caption-job/internal/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchIndex: body.batchIndex,
        startIndex: body.startIndex,
        translations,
        provider: "google-translate",
      }),
    });
    if (!stored.ok) throw new Error(`Caption result storage failed with ${stored.status}`);
    message.ack();
  } catch (error) {
    const reason = error?.message || String(error);
    console.error(`YouTube caption batch ${body.batchIndex} failed on attempt ${message.attempts}:`, reason);
    if (Number(message.attempts || 1) < MAX_QUEUE_ATTEMPTS) {
      message.retry({ delaySeconds: Math.min(30, 2 ** Number(message.attempts || 1)) });
      return;
    }
    await stub.fetch("https://caption-job/internal/failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchIndex: body.batchIndex, reason: reason.slice(0, 300) }),
    });
    message.ack();
  }
}

async function handleQueue(batch, env) {
  await Promise.all(batch.messages.map((message) => processQueueMessage(message, env)));
}

export class CaptionJob extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/initialize") {
      const existing = await this.ctx.storage.get("meta");
      if (!existing) {
        const meta = await request.json();
        await this.ctx.storage.put("meta", meta);
        await this.ctx.storage.setAlarm(Number(meta.createdAt) + JOB_RETENTION_MS);
        return jsonResponse({created: true});
      }
      const requested = await request.json();
      if (existing.itemCount !== requested.itemCount || existing.batchCount !== requested.batchCount) {
        return textResponse("Job Conflict", 409);
      }
      return jsonResponse({created: false});
    }
    if (request.method === "POST" && url.pathname === "/internal/rate-limit") {
      const now = Date.now();
      const saved = await this.ctx.storage.get("rate");
      const state = saved && now - Number(saved.startedAt || 0) < PUBLIC_RATE_WINDOW_MS
        ? saved
        : {startedAt: now, count: 0};
      if (state.count >= PUBLIC_RATE_LIMIT) return textResponse("Too Many Requests", 429);
      state.count += 1;
      await this.ctx.storage.put("rate", state);
      await this.ctx.storage.setAlarm(state.startedAt + PUBLIC_RATE_WINDOW_MS);
      return textResponse("OK", 200);
    }
    if (request.method === "POST" && url.pathname === "/internal/retry") {
      const failures = await this.ctx.storage.list({prefix: "failure:"});
      for (const key of failures.keys()) await this.ctx.storage.delete(key);
      await this.ctx.storage.delete("fatal");
      return textResponse("OK", 200);
    }
    if (request.method === "POST" && url.pathname === "/internal/result") {
      const result = await request.json();
      const suffix = String(result.batchIndex).padStart(6, "0");
      await this.ctx.storage.put(`batch:${suffix}`, {
        ...result,
        savedAt: Date.now(),
      });
      await this.ctx.storage.delete(`failure:${suffix}`);
      return textResponse("OK", 200);
    }
    if (request.method === "POST" && url.pathname === "/internal/failure") {
      const failure = await request.json();
      const suffix = String(failure.batchIndex).padStart(6, "0");
      if (await this.ctx.storage.get(`batch:${suffix}`)) return textResponse("OK", 200);
      await this.ctx.storage.put(`failure:${suffix}`, {
        ...failure,
        savedAt: Date.now(),
      });
      return textResponse("OK", 200);
    }
    if (request.method === "POST" && url.pathname === "/internal/fatal") {
      const failure = await request.json();
      await this.ctx.storage.put("fatal", { ...failure, savedAt: Date.now() });
      return textResponse("OK", 200);
    }
    if (request.method === "GET" && url.pathname.startsWith("/internal/batch/")) {
      const batchIndex = Number(url.pathname.slice("/internal/batch/".length));
      const result = await this.ctx.storage.get(`batch:${String(batchIndex).padStart(6, "0")}`);
      return result ? jsonResponse(result) : textResponse("Not Found", 404);
    }
    if (request.method === "GET" && url.pathname === "/internal/status") {
      const meta = await this.ctx.storage.get("meta");
      if (!meta) return textResponse("Not Found", 404);
      const [results, failures, fatal] = await Promise.all([
        this.ctx.storage.list({ prefix: "batch:" }),
        this.ctx.storage.list({ prefix: "failure:" }),
        this.ctx.storage.get("fatal"),
      ]);
      const translations = new Array(meta.itemCount).fill(null);
      let updatedAt = meta.createdAt;
      for (const result of results.values()) {
        result.translations.forEach((translation, index) => {
          translations[result.startIndex + index] = translation;
        });
        updatedAt = Math.max(updatedAt, Number(result.savedAt || 0));
      }
      for (const failure of failures.values()) updatedAt = Math.max(updatedAt, Number(failure.savedAt || 0));
      if (fatal) updatedAt = Math.max(updatedAt, Number(fatal.savedAt || 0));
      const completedBatches = results.size;
      const failedBatches = failures.size + (fatal ? 1 : 0);
      const settledBatches = completedBatches + failures.size;
      const status = fatal
        ? "failed"
        : (settledBatches >= meta.batchCount
          ? (failures.size ? "failed" : "complete")
          : (settledBatches ? "processing" : "queued"));
      return jsonResponse({
        jobId: meta.jobId,
        status,
        translations,
        itemCount: meta.itemCount,
        batchCount: meta.batchCount,
        completedBatches,
        failedBatches,
        createdAt: meta.createdAt,
        updatedAt,
      });
    }
    return textResponse("Not Found", 404);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

export const __test = {
  captionJobId,
  buildTranslationBatches,
  splitQueueMessages,
  translateGoogleBatch,
  normalizeLanguage,
  validateJobPayload,
  constantTimeEqual,
  hasValidAccessToken,
  allowPublicJob,
  handleRequest,
  handleQueue,
};

export default {
  fetch: handleRequest,
  queue: handleQueue,
};
