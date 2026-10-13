import { DurableObject } from "cloudflare:workers";

const JOBS_PATH = "/caption/jobs";
const WORKER_BUILD = "caption-queue-v22";
const GOOGLE_TRANSLATE_ENDPOINTS = [
  "https://translate.googleapis.com/translate_a/t",
  "https://translate.google.com/translate_a/t",
];
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ITEMS = 5000;
const MAX_LINE_CHARS = 1000;
const MAX_TOTAL_CHARS = 500000;
const MAX_BATCH_ITEMS = 60;
const MAX_BATCH_QUERY_CHARS = 1700;
const MAX_SEND_BATCH_MESSAGES = 100;
const MAX_SEND_BATCH_BYTES = 220 * 1024;
const GOOGLE_TRANSLATE_TIMEOUT_MS = 8000;
const MAX_QUEUE_ATTEMPTS = 6;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_REQUEUE_AFTER_MS = 5 * 60 * 1000;
const FAILED_JOB_REQUEUE_AFTER_MS = 30 * 1000;
const PUBLIC_RATE_WINDOW_MS = 60 * 1000;
const PUBLIC_RATE_LIMIT = 12;
const UPSTREAM_MIN_INTERVAL_MS = 150;
const DEFAULT_UPSTREAM_BACKOFF_MS = 30 * 1000;
const MAX_UPSTREAM_BACKOFF_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_PREFIX = "Bearer ";
const MAX_ACCESS_TOKEN_CHARS = 128;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function translationQuery(texts) {
  return texts.join("\n");
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
        || translationQuery(candidate).length > MAX_BATCH_QUERY_CHARS)
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

function retryAfterMilliseconds(response) {
  const value = String(response.headers.get("retry-after") || "").trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_UPSTREAM_BACKOFF_MS, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(MAX_UPSTREAM_BACKOFF_MS, Math.max(1000, date - Date.now()));
  return DEFAULT_UPSTREAM_BACKOFF_MS;
}

async function fetchGoogleTranslations(texts, source, target, beforeRequest = async () => {}) {
  let lastError;
  let rateLimitError;
  for (const endpoint of GOOGLE_TRANSLATE_ENDPOINTS) {
    await beforeRequest();
    const language = source === "auto" ? source : source.split("-")[0];
    const parameters = new URLSearchParams({client: "dict-chrome-ex", sl: language, tl: target});
    for (const text of texts) parameters.append("q", text);
    const url = `${endpoint}?client=dict-chrome-ex&sl=${encodeURIComponent(language)}&tl=${encodeURIComponent(target)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GOOGLE_TRANSLATE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://translate.google.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        },
        body: parameters.toString(),
        signal: controller.signal,
      });
      if (!response.ok) {
        const statusError = new Error(`Google Translate status ${response.status}`);
        statusError.status = response.status;
        if (response.status === 429) statusError.retryAfterMs = retryAfterMilliseconds(response);
        throw statusError;
      }
      const result = await response.json();
      if (!Array.isArray(result) || result.length !== texts.length) {
        throw new Error("Invalid Google Translate batch response");
      }
      const translations = result.map((value) => typeof value === "string" ? value
        : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "");
      if (!translations.some((value) => value.trim())) throw new Error("Empty Google Translate batch response");
      return translations;
    } catch (error) {
      lastError = new Error(`${new URL(endpoint).hostname}: ${error?.message || String(error)}`);
      lastError.status = error?.status;
      lastError.retryAfterMs = error?.retryAfterMs;
      if (error?.status === 429) {
        rateLimitError = lastError;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw rateLimitError || lastError || new Error("Google Translate unavailable");
}

async function translateGoogleBatch(texts, source, target, beforeRequest = async () => {}) {
  texts = texts.map((text) => text.replace(/\s+/g, " ").trim());
  if (
    texts.length > MAX_BATCH_ITEMS
    || translationQuery(texts).length > MAX_BATCH_QUERY_CHARS
  ) {
    const middle = Math.ceil(texts.length / 2);
    const left = await translateGoogleBatch(texts.slice(0, middle), source, target, beforeRequest);
    const right = await translateGoogleBatch(texts.slice(middle), source, target, beforeRequest);
    return [...left, ...right];
  }
  try {
    const [translated] = await fetchGoogleTranslations([translationQuery(texts)], source, target, beforeRequest);
    const parts = translated.split(/\r?\n/).map((part) => part.trim());
    if (parts.length === texts.length && parts.every(Boolean)) return parts;
  } catch (error) {
    if (error?.status === 429 || texts.length === 1) throw error;
  }

  // A changed line count must never shift translations onto the wrong timestamp.
  const parts = await fetchGoogleTranslations(texts, source, target, beforeRequest);
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index].trim()) {
      const [replacement] = await fetchGoogleTranslations([texts[index]], source, target, beforeRequest);
      parts[index] = replacement;
    }
  }
  if (parts.some((part) => !part.trim())) throw new Error("Incomplete Google Translate batch response");
  return parts.map((part) => part.trim());
}

function jobStub(env, jobId) {
  return env.CAPTION_JOBS.get(env.CAPTION_JOBS.idFromName(jobId));
}

function formatDeterministicJobId(bytes) {
  const value = new Uint8Array(bytes.slice(0, 16));
  value[6] = (value[6] & 0x0f) | 0x40;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function deterministicJobId(payload) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(JSON.stringify([WORKER_BUILD, payload.source, payload.target, payload.texts])),
  );
  return formatDeterministicJobId(new Uint8Array(digest));
}

async function waitForUpstreamSlot(env) {
  const response = await jobStub(env, "upstream:google-translate").fetch(
    "https://caption-job/internal/upstream-slot",
    {method: "POST"},
  );
  if (!response.ok) throw new Error(`Upstream limiter failed with ${response.status}`);
  const {waitMs = 0} = await response.json();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function setUpstreamBackoff(env, delayMs) {
  await jobStub(env, "upstream:google-translate").fetch(
    "https://caption-job/internal/upstream-backoff",
    {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({delayMs}),
    },
  );
}

async function allowPublicJob(request, env) {
  const client = request.headers.get("CF-Connecting-IP") || "unknown-client";
  const response = await jobStub(env, `rate:${client}`).fetch("https://caption-job/internal/rate-limit", {
    method: "POST",
  });
  return response.ok;
}

async function prepareJob(env, jobId, itemCount, batchCount) {
  const response = await jobStub(env, jobId).fetch("https://caption-job/internal/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, itemCount, batchCount, createdAt: Date.now() }),
  });
  if (!response.ok) throw new Error(`Job initialization failed with ${response.status}`);
  return response.json();
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
    if (text.length > MAX_BATCH_QUERY_CHARS) {
      throw Object.assign(new Error("Caption Line Too Large"), { status: 413 });
    }
    totalCharacters += text.length;
    if (totalCharacters > MAX_TOTAL_CHARS) throw Object.assign(new Error("Caption Job Too Large"), { status: 413 });
    normalizedTexts.push(text);
  }
  return { texts: normalizedTexts, source, target };
}

async function createJob(request, env, authenticated = false) {
  if (!env?.CAPTION_QUEUE || !env?.CAPTION_JOBS) return textResponse("Service Unavailable", 503);
  let payload;
  try {
    payload = validateJobPayload(await readRequestJson(request));
  } catch (error) {
    return textResponse(error?.message || "Invalid Caption Job", Number(error?.status) || 400);
  }
  if (!authenticated && !(await allowPublicJob(request, env))) {
    return textResponse("Too Many Requests", 429, {"Retry-After": "60"});
  }

  const batches = buildTranslationBatches(payload.texts);
  const jobId = await deterministicJobId(payload);
  try {
    const prepared = await prepareJob(env, jobId, payload.texts.length, batches.length);
    if (prepared.enqueue) {
      const completed = new Set(prepared.completedBatchIndexes || []);
      const messages = batches
        .map((batch, batchIndex) => ({
          jobId,
          batchIndex,
          startIndex: batch.startIndex,
          texts: batch.texts,
          source: payload.source,
          target: payload.target,
        }))
        .filter((message) => !completed.has(message.batchIndex));
      for (const group of splitQueueMessages(messages)) await env.CAPTION_QUEUE.sendBatch(group);
    }
    return jsonResponse({
      jobId,
      status: "queued",
      statusUrl: `${JOBS_PATH}/${jobId}`,
      pollAfterMs: 500,
      itemCount: payload.texts.length,
      batchCount: batches.length,
      reused: !prepared.created,
      enqueued: Boolean(prepared.enqueue),
    }, 202, { Location: `${JOBS_PATH}/${jobId}` });
  } catch (error) {
    console.error("YouTube caption job enqueue failed:", error?.message || String(error));
    try {
      await failJob(env, jobId, error?.message || String(error));
    } catch (statusError) {
      console.error("YouTube caption job failure state could not be saved:", statusError?.message || String(statusError));
    }
    return textResponse("Caption Job Enqueue Failed", 502);
  }
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
      return createJob(request, env, authenticated);
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
    const provider = "google-translate";
    const translations = await translateGoogleBatch(
      body.texts,
      body.source,
      body.target,
      () => waitForUpstreamSlot(env),
    );
    if (translations.length !== body.texts.length || translations.some((text) => !text)) {
      throw new Error("Incomplete caption translation response");
    }
    const stored = await stub.fetch("https://caption-job/internal/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchIndex: body.batchIndex,
        startIndex: body.startIndex,
        translations,
        provider,
      }),
    });
    if (!stored.ok) throw new Error(`Caption result storage failed with ${stored.status}`);
    message.ack();
  } catch (error) {
    const reason = error?.message || String(error);
    console.error(`YouTube caption batch ${body.batchIndex} failed on attempt ${message.attempts}:`, reason);
    if (error?.status === 429) {
      await setUpstreamBackoff(env, error?.retryAfterMs || DEFAULT_UPSTREAM_BACKOFF_MS);
    }
    if (Number(message.attempts || 1) < MAX_QUEUE_ATTEMPTS) {
      const delaySeconds = error?.status === 429
        ? Math.min(300, 30 * (2 ** Math.max(0, Number(message.attempts || 1) - 1)))
        : Math.min(30, 2 ** Number(message.attempts || 1));
      message.retry({ delaySeconds });
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
    if (request.method === "POST" && url.pathname === "/internal/upstream-slot") {
      const now = Date.now();
      const state = await this.ctx.storage.get("upstream") || {};
      const scheduledAt = Math.max(now, Number(state.nextAt || 0), Number(state.blockedUntil || 0));
      await this.ctx.storage.put("upstream", {
        ...state,
        nextAt: scheduledAt + UPSTREAM_MIN_INTERVAL_MS,
      });
      return jsonResponse({waitMs: Math.max(0, scheduledAt - now)});
    }
    if (request.method === "POST" && url.pathname === "/internal/upstream-backoff") {
      const now = Date.now();
      const state = await this.ctx.storage.get("upstream") || {};
      const body = await request.json();
      const delayMs = Math.max(
        1000,
        Math.min(MAX_UPSTREAM_BACKOFF_MS, Number(body.delayMs) || DEFAULT_UPSTREAM_BACKOFF_MS),
      );
      const blockedUntil = Math.max(Number(state.blockedUntil || 0), now + delayMs);
      await this.ctx.storage.put("upstream", {
        ...state,
        blockedUntil,
        nextAt: Math.max(Number(state.nextAt || 0), blockedUntil),
      });
      return jsonResponse({blockedUntil});
    }
    if (request.method === "POST" && url.pathname === "/internal/prepare") {
      const incoming = await request.json();
      const now = Date.now();
      const existing = await this.ctx.storage.get("meta");
      if (!existing) {
        await this.ctx.storage.put("meta", {...incoming, lastEnqueuedAt: now});
        await this.ctx.storage.setAlarm(Number(incoming.createdAt) + JOB_RETENTION_MS);
        return jsonResponse({created: true, enqueue: true, completedBatchIndexes: []});
      }
      if (existing.itemCount !== incoming.itemCount || existing.batchCount !== incoming.batchCount) {
        return textResponse("Job Shape Conflict", 409);
      }
      const [results, failures, fatal] = await Promise.all([
        this.ctx.storage.list({prefix: "batch:"}),
        this.ctx.storage.list({prefix: "failure:"}),
        this.ctx.storage.get("fatal"),
      ]);
      const completedBatchIndexes = [...results.values()].map((result) => result.batchIndex);
      if (results.size >= existing.batchCount && !failures.size && !fatal) {
        return jsonResponse({created: false, enqueue: false, completedBatchIndexes});
      }
      const settled = results.size + failures.size;
      let updatedAt = Number(existing.lastEnqueuedAt || existing.createdAt || 0);
      for (const failure of failures.values()) updatedAt = Math.max(updatedAt, Number(failure.savedAt || 0));
      if (fatal) updatedAt = Math.max(updatedAt, Number(fatal.savedAt || 0));
      const failed = Boolean(fatal) || (settled >= existing.batchCount && failures.size > 0);
      const retryable = failed
        ? now - updatedAt >= FAILED_JOB_REQUEUE_AFTER_MS
        : now - Number(existing.lastEnqueuedAt || existing.createdAt || 0) >= JOB_REQUEUE_AFTER_MS;
      if (!retryable) {
        return jsonResponse({created: false, enqueue: false, completedBatchIndexes});
      }
      for (const key of failures.keys()) await this.ctx.storage.delete(key);
      if (fatal) await this.ctx.storage.delete("fatal");
      await this.ctx.storage.put("meta", {...existing, lastEnqueuedAt: now});
      return jsonResponse({created: false, enqueue: true, completedBatchIndexes});
    }
    if (request.method === "POST" && url.pathname === "/internal/initialize") {
      const existing = await this.ctx.storage.get("meta");
      if (!existing) {
        const meta = await request.json();
        await this.ctx.storage.put("meta", meta);
        await this.ctx.storage.setAlarm(Number(meta.createdAt) + JOB_RETENTION_MS);
      }
      return textResponse("OK", 200);
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
  buildTranslationBatches,
  splitQueueMessages,
  translateGoogleBatch,
  normalizeLanguage,
  validateJobPayload,
  constantTimeEqual,
  hasValidAccessToken,
  handleRequest,
  handleQueue,
};

export default {
  fetch: handleRequest,
  queue: handleQueue,
};
