// Durable coordination shared by the two independent translation Workers.
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 120000;

export function json(body, status = 200) {
  return Response.json(body, {status, headers: {"Cache-Control": "no-store"}});
}

export async function identifier(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

// A cache fingerprint, not an authentication primitive. Also available in Surge's JS engine.
export function fingerprint(text) {
  let first = 2166136261, second = 2246822519;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second ^ text.charCodeAt(index), 3266489917);
  }
  return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function stub(namespace, id) {
  return namespace.get(namespace.idFromName(id));
}

export async function jobCall(namespace, id, action, body) {
  const response = await stub(namespace, id).fetch(`https://prewarm.internal/${action}`, body === undefined
    ? {} : {method: "POST", body: JSON.stringify(body)});
  if (!response.ok) throw new Error("Prewarm state unavailable");
  return response.json();
}

export async function enqueue(namespace, queue, id, work) {
  const claim = await jobCall(namespace, id, "prepare", {work});
  if (claim.enqueue) {
    try { await queue.send({prewarm: true, jobId: id}); }
    catch (error) {
      await jobCall(namespace, id, "failed", {});
      throw error;
    }
  }
  return {jobId: id, reused: !claim.enqueue};
}

export async function consume(message, namespace, perform) {
  const id = message.body?.jobId;
  if (!/^(?:batch:)?[a-f0-9]{64}$/.test(id || "")) { message.ack(); return; }
  const claimed = await jobCall(namespace, id, "run", {});
  if (!claimed.run) {
    if (claimed.status === "processing") message.retry({delaySeconds: 125});
    else message.ack();
    return;
  }
  try {
    const result = await perform(claimed.work);
    await jobCall(namespace, id, "complete", {result});
    message.ack();
  } catch (error) {
    const code = String(error?.code || "prewarm-failed").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
    console.log(`Translation prewarm: ${code}`);
    if (message.attempts < 5 && error?.retryable !== false) {
      await jobCall(namespace, id, "retry", {});
      message.retry({delaySeconds: Number.isFinite(error?.retryAfterSeconds)
        ? Math.max(1, Math.min(120, error.retryAfterSeconds)) : Math.min(120, 15 * message.attempts)});
    } else {
      await jobCall(namespace, id, "failed", {code});
      message.ack();
    }
  }
}

// Exported under a distinct class name by each Worker; no cross-service credentials or state.
export class PrewarmJob {
  constructor(ctx) { this.ctx = ctx; this.tail = Promise.resolve(); }
  async storeBody(entry, previous) {
    if (!entry || typeof entry.body !== "string") return entry;
    const {body, ...rest} = entry;
    const hash = fingerprint(body);
    let bodyRef = previous?.hash === hash ? previous : null;
    if (!bodyRef) {
      const count = Math.ceil(body.length / 16000);
      for (let index = 0; index < count; index++) await this.ctx.storage.put(`body:${index}`, body.slice(index * 16000, (index + 1) * 16000));
      bodyRef = {count, hash};
    }
    return {...rest, bodyRef};
  }
  async loadBody(entry) {
    if (!entry?.bodyRef) return entry;
    const parts = await Promise.all(Array.from({length: entry.bodyRef.count}, (_, index) => this.ctx.storage.get(`body:${index}`)));
    if (parts.some((part) => typeof part !== "string")) throw new Error("Incomplete prewarm source");
    const body = parts.join("");
    if (fingerprint(body) !== entry.bodyRef.hash) throw new Error("Invalid prewarm source");
    return {...entry, body};
  }
  fetch(request) {
    const operation = this.tail.then(() => this.handle(request));
    this.tail = operation.catch(() => {});
    return operation;
  }
  async handle(request) {
    const action = new URL(request.url).pathname.slice(1);
    let state = await this.ctx.storage.get("state");
    if (state && Date.now() - state.createdAt >= JOB_TTL_MS) state = null;
    if (request.method === "GET") return json(state ? {...state, work: await this.loadBody(state.work), result: await this.loadBody(state.result)} : {status: "missing"});
    const payload = await request.json();
    if (action === "prepare") {
      if (state && !["failed", "missing"].includes(state.status)) return json({enqueue: false, status: state.status});
      state = {status: "queued", work: await this.storeBody(payload.work), createdAt: Date.now()};
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.setAlarm(Date.now() + JOB_TTL_MS);
      return json({enqueue: true});
    }
    if (!state) return json({status: "missing", run: false});
    if (action === "run") {
      if (state.status === "complete" || state.status === "failed") return json({run: false, status: state.status});
      if (state.status === "processing" && state.leaseUntil > Date.now()) return json({run: false, status: "processing"});
      state.status = "processing"; state.leaseUntil = Date.now() + LEASE_MS;
      await this.ctx.storage.put("state", state);
      return json({run: true, work: await this.loadBody(state.work)});
    }
    if (action === "complete") state = {status: "complete", result: await this.storeBody(payload.result, state.work?.bodyRef), createdAt: state.createdAt};
    else if (action === "retry") { state.status = "queued"; delete state.leaseUntil; }
    else if (action === "failed") state = {status: "failed", createdAt: state.createdAt, code: payload.code};
    else return json({error: "Unknown action"}, 400);
    await this.ctx.storage.put("state", state);
    return json({ok: true});
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

export async function fetchDocument(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {...init, redirect: "manual", signal: controller.signal});
    if (response.status !== 200) throw Object.assign(new Error("Source unavailable"), {
      code: `source-http-${response.status}`, retryable: response.status === 429 || response.status >= 500});
    const text = await readLimitedText(response, 1500000);
    if (!text || text.length > 1500000) throw Object.assign(new Error("Source unavailable"), {code: text ? "source-too-large" : "source-empty", retryable: false});
    return text;
  } finally { clearTimeout(timer); }
}

export async function readLimitedText(message, maxBytes) {
  const tooLarge = () => Object.assign(new Error("Document too large"), {code: "source-too-large", retryable: false, status: 413});
  if (Number(message.headers.get("Content-Length")) > maxBytes) throw tooLarge();
  if (!message.body) return "";
  const reader = message.body.getReader(), decoder = new TextDecoder();
  let total = 0, text = "";
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw tooLarge(); }
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export function captionSource(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || url.port || url.username || url.password
    || url.pathname !== "/api/timedtext" || value.length > 12000) throw new Error("Invalid caption source");
  const videoId = url.searchParams.get("v"), source = url.searchParams.get("lang");
  if (!/^[\w-]{11}$/.test(videoId || "") || !/^[a-z]{2,3}(?:-[\w-]+)?$/i.test(source || "")) throw new Error("Invalid caption track");
  url.searchParams.delete("tlang"); url.searchParams.delete("enhance_tlang"); url.searchParams.set("fmt", "srv3");
  return {url: url.href, source, track: [videoId, source, url.searchParams.get("kind") || "", url.searchParams.get("name") || ""]};
}

function decodeXml(text) {
  return text.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
export function parseCaptions(body) {
  if (!/<timedtext\b/.test(body)) throw new Error("Invalid caption document");
  const entries = [], paragraph = /<p(\s[^>]*)?>([\s\S]*?)<\/p>/g, segment = /<s(?:\s[^>]*)?>([\s\S]*?)<\/s>/g;
  let match;
  while ((match = paragraph.exec(body))) {
    const pieces = []; let part; segment.lastIndex = 0;
    while ((part = segment.exec(match[2]))) pieces.push(part[1]);
    const text = decodeXml(pieces.length ? pieces.join("") : match[2].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (text) entries.push({start: match.index, end: paragraph.lastIndex, attributes: match[1] || "", text});
  }
  if (!entries.length) throw new Error("Empty captions");
  return entries;
}
export function renderCaptions(body, entries, translations) {
  if (entries.length !== translations.length || translations.some((s) => typeof s !== "string" || !s.trim())) throw new Error("Incomplete captions");
  const encode = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  let output = "", position = 0;
  entries.forEach((entry, index) => {
    output += body.slice(position, entry.start) + `<p${entry.attributes}><s ac="0">${encode(translations[index])}</s></p>`;
    position = entry.end;
  });
  return output + body.slice(position);
}

export function lyricBatches(lines) {
  const batches = []; let batch = [], characters = 0;
  for (const line of [...new Set(lines)]) {
    if (batch.length && (batch.length >= 12 || characters + line.length > 600)) { batches.push(batch); batch = []; characters = 0; }
    batch.push(line); characters += line.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function visit(value, predicate, depth = 0) {
  if (!value || typeof value !== "object" || depth > 24) return null;
  const matched = predicate(value); if (matched) return matched;
  for (const child of Object.values(value)) {
    const found = visit(child, predicate, depth + 1); if (found) return found;
  }
  return null;
}

export async function fetchMusicLyrics(videoId) {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error("Invalid video");
  const context = {client: {clientName: "WEB_REMIX", clientVersion: "1.20261026.01.00", hl: "en", gl: "HK"}};
  async function api(path, payload) {
    return JSON.parse(await fetchDocument(`https://music.youtube.com/youtubei/v1/${path}?prettyPrint=false`, {
      method: "POST", headers: {"Content-Type": "application/json", "Origin": "https://music.youtube.com"}, body: JSON.stringify({context, ...payload}),
    }));
  }
  const next = await api("next", {videoId});
  const browseId = visit(next, (node) => {
    const id = node.browseEndpoint?.browseId;
    return typeof id === "string" && /^MPLY[\w-]{1,300}$/.test(id) ? id : null;
  });
  if (!browseId) return [];
  const document = await api("browse", {browseId});
  const description = visit(document, (node) => node.musicDescriptionShelfRenderer?.description || null);
  const text = description?.runs?.map((run) => run.text || "").join("") || description?.simpleText || "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1000 || text.length > 60000) throw new Error("Lyrics too large");
  return lines;
}
