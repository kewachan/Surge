const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;

const directory = __dirname;
const workerPath = path.join(directory, "youtube.caption.worker.js");
const clientPath = path.join(directory, "youtube.caption.js");
const accessToken = "caption-test-token-0123456789abcdef0123456789abcdef";
const authorization = {Authorization: `Bearer ${accessToken}`};

class MockStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix || "";
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }

  async setAlarm(value) {
    this.alarm = value;
  }

  async deleteAll() {
    this.values.clear();
  }
}

async function loadWorker() {
  const source = fs.readFileSync(workerPath, "utf8").replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

class MockDurableObjectNamespace {
  constructor(WorkerClass) {
    this.WorkerClass = WorkerClass;
    this.objects = new Map();
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    if (!this.objects.has(id)) {
      const storage = new MockStorage();
      const instance = new this.WorkerClass({storage}, {});
      this.objects.set(id, {instance, storage});
    }
    const {instance} = this.objects.get(id);
    return {
      fetch(input, init) {
        return instance.fetch(input instanceof Request ? input : new Request(input, init));
      },
    };
  }
}

function queueMessage(body, attempts = 1) {
  return {
    body,
    attempts,
    acknowledged: false,
    retried: false,
    retryOptions: null,
    ack() { this.acknowledged = true; },
    retry(options) {
      this.retried = true;
      this.retryOptions = options;
    },
  };
}

function translatedGoogleResponse(query, marker = "YTC") {
  const markerPattern = marker === "YTC"
    ? /(\n\uE000YTC\d+\uE001\n)/gu
    : new RegExp(`(\\n\\[\\[${marker}:\\d+\\]\\]\\n)`, "g");
  const exactMarkerPattern = marker === "YTC"
    ? /^\n\uE000YTC\d+\uE001\n$/u
    : new RegExp(`^\\n\\[\\[${marker}:\\d+\\]\\]\\n$`);
  const translated = query.split(markerPattern)
    .map((part) => (exactMarkerPattern.test(part) ? part : `譯:${part}`))
    .join("");
  return Response.json([[[translated, query]]]);
}

async function verifyWorkerQueue(worker) {
  const queuedBodies = [];
  let googleRuns = 0;
  const namespace = new MockDurableObjectNamespace(worker.CaptionJob);
  const env = {
    CAPTION_ACCESS_TOKEN: accessToken,
    CAPTION_JOBS: namespace,
    CAPTION_QUEUE: {
      async sendBatch(messages) {
        for (const message of messages) queuedBodies.push(message.body);
      },
    },
  };
  const texts = Array.from({length: 180}, (_, index) => (
    `Long caption ${index}: a sufficiently detailed sentence for queue batching and ordering checks.`
  ));
  const requestInit = {
    method: "POST",
    headers: {...authorization, "Content-Type": "application/json"},
    body: JSON.stringify({purpose: "captions", source: "en", target: "zh-Hant", texts}),
  };
  const createResponse = await worker.default.fetch(
    new Request("https://worker.test/caption/jobs", requestInit),
    env,
  );
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.match(created.jobId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.itemCount, texts.length);
  assert(queuedBodies.length > 1, "long caption jobs must be split into multiple queue messages");
  assert(queuedBodies.every((body) => body.texts.length <= 60), "Google batches must stay below the stable item limit");

  const originalBatchCount = queuedBodies.length;
  const duplicateResponse = await worker.default.fetch(
    new Request("https://worker.test/caption/jobs", requestInit),
    env,
  );
  assert.equal(duplicateResponse.status, 202);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.jobId, created.jobId, "identical caption payloads must reuse one deterministic job");
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.enqueued, false);
  assert.equal(queuedBodies.length, originalBatchCount, "duplicate jobs must not enqueue duplicate batches");

  const publicStatus = await worker.default.fetch(
    new Request(`https://worker.test/caption/jobs/${created.jobId}`),
    env,
  );
  assert.equal(publicStatus.status, 200);
  const unauthorized = await worker.default.fetch(new Request(
    `https://worker.test/caption/jobs/${created.jobId}`,
    {headers: {Authorization: "Bearer invalid-caption-token"}},
  ), env);
  assert.equal(unauthorized.status, 401);

  const publicEnv = {
    CAPTION_JOBS: new MockDurableObjectNamespace(worker.CaptionJob),
    CAPTION_QUEUE: {async sendBatch() {}},
  };
  const publicStatuses = [];
  for (let index = 0; index <= 12; index++) {
    const response = await worker.default.fetch(new Request("https://worker.test/caption/jobs", {
      method: "POST",
      headers: {"CF-Connecting-IP": "198.51.100.9", "Content-Type": "application/json"},
      body: JSON.stringify({
        purpose: "captions",
        source: "en",
        target: "zh-Hant",
        texts: [`Public caption ${index}`],
      }),
    }), publicEnv);
    publicStatuses.push(response.status);
  }
  assert.deepEqual(publicStatuses.slice(0, 12), Array(12).fill(202));
  assert.equal(publicStatuses[12], 429);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    googleRuns++;
    assert.equal(new URL(url).pathname, "/translate_a/t");
    assert.equal(options.method, "POST");
    const queries = new URLSearchParams(options.body).getAll("q");
    return Response.json(queries.map((query) => query.split("\n").map((text) => `譯:${text}`).join("\n")));
  };
  try {
    for (const body of queuedBodies) {
      const message = queueMessage(body);
      await worker.default.queue({messages: [message]}, env);
      assert.equal(message.acknowledged, true);
      assert.equal(message.retried, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(googleRuns, queuedBodies.length, "each queued caption batch should use one Google request");

  const statusResponse = await worker.default.fetch(new Request(
    `https://worker.test/caption/jobs/${created.jobId}`,
    {headers: authorization},
  ), env);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, "complete");
  assert.equal(status.completedBatches, queuedBodies.length);
  assert.equal(status.failedBatches, 0);
  assert.equal(status.translations.length, texts.length);
  assert.equal(status.translations[0], `譯:${texts[0]}`);
  assert.equal(status.translations.at(-1), `譯:${texts.at(-1)}`);

  const lifecycleId = crypto.randomUUID();
  const lifecycle = namespace.get(lifecycleId);
  await lifecycle.fetch("https://caption-job/internal/initialize", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({jobId: lifecycleId, itemCount: 2, batchCount: 2, createdAt: Date.now()}),
  });
  await lifecycle.fetch("https://caption-job/internal/failure", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({batchIndex: 0, reason: "expected test failure"}),
  });
  let lifecycleStatus = await (await lifecycle.fetch("https://caption-job/internal/status")).json();
  assert.equal(lifecycleStatus.status, "processing", "one failed batch must not end a job with unsettled batches");
  await lifecycle.fetch("https://caption-job/internal/result", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({batchIndex: 1, startIndex: 1, translations: ["second"]}),
  });
  lifecycleStatus = await (await lifecycle.fetch("https://caption-job/internal/status")).json();
  assert.equal(lifecycleStatus.status, "failed");
  await lifecycle.fetch("https://caption-job/internal/result", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({batchIndex: 0, startIndex: 0, translations: ["first"]}),
  });
  lifecycleStatus = await (await lifecycle.fetch("https://caption-job/internal/status")).json();
  assert.equal(lifecycleStatus.status, "complete", "a late successful result must clear a stale batch failure");

  const retryBody = {...queuedBodies[0], jobId: crypto.randomUUID()};
  const retryMessage = queueMessage(retryBody, 1);
  let googleRetryRequests = 0;
  globalThis.fetch = async () => {
    googleRetryRequests++;
    return new Response("Rate limited", {
      status: 429,
      headers: {"Retry-After": "30"},
    });
  };
  try {
    await worker.default.queue({messages: [retryMessage]}, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(retryMessage.acknowledged, false);
  assert.equal(retryMessage.retried, true);
  assert(retryMessage.retryOptions.delaySeconds >= 30);
  assert(googleRetryRequests > 0, "Google rate limits must stay in the queue retry path");

  let alternateRuns = 0;
  globalThis.fetch = async (url, options) => {
    alternateRuns++;
    if (new URL(url).hostname === "translate.googleapis.com") return new Response("Rate limited", {status: 429});
    const query = new URLSearchParams(options.body).get("q");
    return Response.json([query.split("\n").map((text) => `後備:${text}`).join("\n")]);
  };
  try {
    assert.deepEqual(await worker.__test.translateGoogleBatch(["one", "two"], "en-US", "zh-TW"), ["後備:one", "後備:two"]);
    assert.equal(alternateRuns, 2, "one rejected Google host must not prevent trying the other host");
  } finally { globalThis.fetch = originalFetch; }

  let alignmentRuns = 0;
  globalThis.fetch = async (_url, options) => {
    alignmentRuns++;
    const queries = new URLSearchParams(options.body).getAll("q");
    if (queries.length === 1 && queries[0].includes("\n")) return Response.json(["merged lines"]);
    if (queries.length > 1) return Response.json(["獨立:one", ""]);
    return Response.json([`補漏:${queries[0]}`]);
  };
  try {
    assert.deepEqual(await worker.__test.translateGoogleBatch(["one", "two"], "en", "zh-TW"), ["獨立:one", "補漏:two"]);
    assert.equal(alignmentRuns, 3, "changed line boundaries and missing translations must be repaired");
  } finally { globalThis.fetch = originalFetch; }

  return {
    jobId: created.jobId,
    itemCount: texts.length,
    batchCount: queuedBodies.length,
    publicRateLimitedAccess: true,
    deterministicJobDedupe: true,
    googleTranslateOnly: true,
    googleRateLimitRetry: true,
    alternateGoogleHost: true,
    lineAlignmentAndEmptyRepair: true,
    waitsForAllBatches: true,
    lateSuccessRecovery: true,
  };
}

function runCaptionClient(queueResults, captionToken = "", options = {}) {
  const source = fs.readFileSync(clientPath, "utf8");
  const captionCount = Number(options.captionCount) || 3;
  const captionTexts = Array.from({length: captionCount}, (_, index) => (
    index < 3 ? ["A", "B", "C"][index] : `Caption ${index + 1}`
  ));
  const xml = options.body || '<?xml version="1.0"?><timedtext format="3"><body>'
    + captionTexts.map((text, index) => `<p t="${index * 1000}" d="1000"><s>${text}</s></p>`).join("")
    + '</body></timedtext>';
  const requests = {sourceGets: 0, queuePosts: 0, queuePolls: 0, googlePosts: 0, rejectedAuthorization: 0};
  const store = options.store || new Map();
  const jobId = "123e4567-e89b-42d3-a456-426614174000";
  const queuedResults = Array.isArray(queueResults) ? queueResults : [queueResults];
  const pendingTimers = new Set();
  let finished = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("caption client test timed out")), 8000);
    const context = {
      console,
      encodeURIComponent,
      decodeURIComponent,
      setTimeout(callback, delay) {
        const pending = setTimeout(() => { pendingTimers.delete(pending); if (!finished) callback(); }, delay);
        pendingTimers.add(pending);
        return pending;
      },
      clearTimeout(pending) { clearTimeout(pending); pendingTimers.delete(pending); },
      $argument: JSON.stringify({captionToken, debug: false}),
      $request: {url: options.url || "https://www.youtube.com/api/timedtext?v=test&lang=en&enhance_tlang=zh-TW&format=srv3"},
      $response: {status: options.status || 200, body: xml, headers: {"Content-Type": "text/xml"}},
      $persistentStore: {
        read(key) { return store.get(key) || null; },
        write(value, key) {
          if (value) store.set(key, value);
          else store.delete(key);
          return true;
        },
      },
      $httpClient: {
        post(request, callback) {
          try {
            if (new URL(request.url).pathname === "/translate_a/t") {
              requests.googlePosts++;
              assert(request.timeout > 0);
              const queries = new URLSearchParams(request.body).getAll("q");
              if (options.failGoogle) callback(null, {status: 429}, "Google unavailable");
              else callback(null, {status: 200}, JSON.stringify(queries.map((query) => query.split("\n").map((text) => `譯:${text}`).join("\n"))));
              return;
            }
            requests.queuePosts++;
            assert.equal(request.url, "https://youtube-caption-translate.hmtw47cv7m.workers.dev/caption/jobs");
            if (request.headers.Authorization) {
              assert.equal(request.headers.Authorization, `Bearer ${captionToken}`);
            }
            if (!options.body && !options.sourceBody) assert.deepEqual(JSON.parse(request.body).texts, captionTexts);
            if (options.rejectAuthorizedOnce && request.headers.Authorization && !requests.rejectedAuthorization) {
              requests.rejectedAuthorization++;
              callback(null, {status: 401}, "Unauthorized");
              return;
            }
            callback(null, {status: 202}, JSON.stringify({jobId, pollAfterMs: 250}));
          } catch (error) {
            reject(error);
          }
        },
        get(request, callback) {
          try {
            if (request.url.startsWith("https://www.youtube.com/api/timedtext?")) {
              requests.sourceGets++;
              assert.equal(request.timeout, options.loon ? 3000 : 3);
              const url = new URL(request.url);
              assert.equal(url.searchParams.has("tlang"), false);
              assert.equal(url.searchParams.get("enhance_tlang"), "zh-TW");
              if (options.sourceBody) callback(null, {status: 200, headers: {"Content-Type": "text/xml", "Content-Length": "1"}}, options.sourceBody);
              else callback(null, {status: 429}, "Source captions unavailable in this recovery test");
              return;
            }
            if (request.url.startsWith("https://youtube-caption-translate.hmtw47cv7m.workers.dev/")) {
              requests.queuePolls++;
              const queueResult = queuedResults[Math.min(requests.queuePolls - 1, queuedResults.length - 1)];
              if (queueResult instanceof Error) callback(queueResult);
              else callback(null, {status: 200}, JSON.stringify(queueResult));
              return;
            }
            throw new Error(`Unexpected GET endpoint: ${new URL(request.url).pathname}`);
          } catch (error) {
            reject(error);
          }
        },
      },
      $done(result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const pending of pendingTimers) clearTimeout(pending);
        resolve({result, requests, store, upstreamBody: xml});
      },
    };
    if (options.loon) context.$loon = "caption-regression";
    try {
      vm.runInNewContext(source, context, {filename: clientPath});
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function rewrittenCaptionUrl(url) {
  let result;
  vm.runInNewContext(fs.readFileSync(clientPath, "utf8"), {
    console, encodeURIComponent, decodeURIComponent,
    $request: {url},
    $done(value) { result = value; },
  });
  return result.url;
}

async function verifySourceCaptions() {
  const base = "https://www.youtube.com/api/timedtext?v=test&lang=th&signature=a%2Bb%2Fc&fmt=srv3";
  assert.equal(rewrittenCaptionUrl(`${base}&tlang=zh-Hant`), `${base}&enhance_tlang=zh-TW`);
  assert.equal(rewrittenCaptionUrl(`${base}&tlang=zh-TW`), `${base}&enhance_tlang=zh-TW`);
  assert.equal(rewrittenCaptionUrl(`${base}&enhance_tlang=zh-TW`), `${base}&enhance_tlang=zh-TW`);
  assert.equal(rewrittenCaptionUrl(`${base}&tlang=zh-CN#caption`), `${base}&enhance_tlang=zh-CN#caption`);
  assert.equal(rewrittenCaptionUrl(`${base}&enhance_tlang=zh-TW&tlang=ja`), `${base}&enhance_tlang=ja`);
  assert.equal(rewrittenCaptionUrl(base), base);

  const native = await runCaptionClient(null, "", {
    url: `${base}&tlang=zh-Hant`, captionCount: 3617,
  });
  assert.equal(Object.keys(native.result).length, 0, "native caption XML must be returned untouched");
  assert.equal(Object.values(native.requests).reduce((a, b) => a + b, 0), 0,
    "a long native response must not wait for or submit a background job");

  const json3 = await runCaptionClient(null, "", {
    url: `${base.replace("fmt=srv3", "fmt=json3")}&tlang=zh-Hant`,
    body: '{"events":[{"segs":[{"utf8":"已翻譯"}]}]}',
  });
  assert.equal(Object.keys(json3.result).length, 0, "native non-srv3 caption formats must be preserved");

  const sourceBody = '<timedtext format="3"><body><p t="0" d="1000"><s>A</s></p><p t="1000" d="1000"><s>B</s></p><p t="2000" d="1000"><s>C</s></p></body></timedtext>';
  const ready = {status: "complete", translations: ["復原:A", "復原:B", "復原:C"], completedBatches: 1, batchCount: 1};
  const recoveryOptions = {url: `${base}&tlang=zh-Hant`, status: 429, body: "<html>Sorry automated queries</html>", sourceBody};
  const recovered = await runCaptionClient(ready, "", recoveryOptions);
  assert.equal(recovered.result.status, 200);
  assert.match(recovered.result.body, /復原:A/);
  assert.equal(recovered.requests.sourceGets, 1);
  assert.equal(recovered.requests.queuePosts, 1);
  assert.equal(recovered.requests.googlePosts, 0);
  assert.equal(recovered.result.headers["Content-Length"], undefined);

  const loonRecovered = await runCaptionClient(ready, "", {...recoveryOptions, loon: true});
  assert.equal(loonRecovered.result.status, 200);
  assert.match(loonRecovered.result.body, /復原:C/);
  assert.equal(loonRecovered.requests.sourceGets, 1);

  let harRequests = 0;
  if (process.env.CAPTION_HAR_PATH) {
    const har = JSON.parse(fs.readFileSync(process.env.CAPTION_HAR_PATH, "utf8"));
    for (const entry of har.log.entries) {
      if (!entry.request.url.includes("/api/timedtext?") || new URL(entry.request.url).searchParams.has("tlang")) continue;
      const content = entry.response.content;
      const body = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
      const url = rewrittenCaptionUrl(`${entry.request.url}&tlang=zh-Hant`);
      assert.equal(new URL(url).searchParams.has("tlang"), false);
      assert.equal(new URL(url).searchParams.get("enhance_tlang"), "zh-TW");
      const captionCount = [...body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)]
        .filter((match) => match[1].replace(/<[^>]*>/g, "").trim()).length;
      const translations = Array.from({length: captionCount}, (_, index) => `繁中字幕${index}`);
      const replay = await runCaptionClient({status: "complete", translations, batchCount: 1, completedBatches: 1}, "", {url, body});
      assert.equal(replay.result.status, 200);
      assert.match(replay.result.body, /繁中字幕0/);
      assert.equal(replay.requests.googlePosts, 0);
      harRequests++;
    }
    assert(harRequests > 0, "HAR regression input must include caption requests");
  }
  return {nativeTranslationParameterRemoved: true,signedParametersPreserved: true,
    native429Recovery: true,loon429Recovery: true,harRequestRegressions: harRequests};
}

async function verifyClientQueue() {
  const sharedStore = new Map();
  const complete = await runCaptionClient([
    new Error("transient queue polling timeout"),
    {
      status: "processing",
      translations: [null, null, null],
      completedBatches: 0,
      batchCount: 1,
    },
    {
      status: "complete",
      translations: ["隊列:A", "隊列:B", "隊列:C"],
      completedBatches: 1,
      batchCount: 1,
    },
  ], "", {store: sharedStore, failGoogle: true});
  assert.equal(complete.requests.queuePosts, 1);
  assert.equal(complete.requests.queuePolls, 3);
  assert(complete.requests.googlePosts <= 1, "a transient poll failure may start one bounded direct fallback");
  assert.match(complete.result.body, /隊列:A/);
  assert.match(complete.result.body, /隊列:B/);
  assert.match(complete.result.body, /隊列:C/);
  assert([...sharedStore.keys()].some((key) => key.startsWith("YouTubeCaption.Job.v20.")));

  for (const key of [...sharedStore.keys()]) {
    if (key.startsWith("YouTubeCaption.v6.") || key === "YouTubeCaption.CacheIndex.v6") {
      sharedStore.delete(key);
    }
  }
  const reusedJob = await runCaptionClient({
    status: "complete",
    translations: ["重用:A", "重用:B", "重用:C"],
    completedBatches: 1,
    batchCount: 1,
  }, "", {store: sharedStore});
  assert.equal(reusedJob.requests.queuePosts, 0, "a repeated caption request must poll its saved job");
  assert.equal(reusedJob.requests.queuePolls, 1);
  assert.equal(reusedJob.requests.googlePosts, 0);
  assert.match(reusedJob.result.body, /重用:A/);

  const staleToken = await runCaptionClient({
    status: "complete",
    translations: ["隊列:A", "隊列:B", "隊列:C"],
    completedBatches: 1,
    batchCount: 1,
  }, accessToken, {rejectAuthorizedOnce: true});
  assert.equal(staleToken.requests.queuePosts, 2);
  assert.equal(staleToken.requests.rejectedAuthorization, 1);
  assert.equal(staleToken.requests.googlePosts, 0);

  const partial = await runCaptionClient({
    status: "failed",
    translations: ["隊列:A", null, "隊列:C"],
    completedBatches: 1,
    failedBatches: 1,
    batchCount: 2,
  });
  assert.equal(partial.requests.queuePosts, 1);
  assert.equal(partial.requests.queuePolls, 1);
  assert.equal(partial.requests.googlePosts, 1);
  assert.match(partial.result.body, /隊列:A/);
  assert.match(partial.result.body, /譯:B/);
  assert.match(partial.result.body, /隊列:C/);

  const longCount = 161;
  const longFailure = await runCaptionClient({
    status: "failed",
    translations: new Array(longCount).fill(null),
    completedBatches: 0,
    failedBatches: 1,
    batchCount: 1,
  }, "", {captionCount: longCount});
  assert.equal(longFailure.requests.queuePosts, 1);
  assert.equal(longFailure.requests.queuePolls, 1);
  assert(longFailure.requests.googlePosts > 0, "a bounded long caption can use the working Google POST fallback");
  assert.equal(longFailure.result.status, 200);
  assert.match(longFailure.result.body, /譯:Caption 161/);

  const pendingCount = 4000;
  const waiting = await runCaptionClient({status: "processing", translations: Array(pendingCount).fill(null), batchCount: 70, completedBatches: 0}, "",
    {captionCount: pendingCount});
  assert.equal(waiting.result.status, 503);
  assert.equal(waiting.result.headers["X-YouTube-Caption-State"], "pending");
  assert.equal(waiting.requests.googlePosts, 0, "very large uncached transcripts must stay in the background queue");
  assert.doesNotMatch(waiting.result.body, /Caption 4000/);
  const finished = await runCaptionClient({status: "complete", translations: Array.from({length: pendingCount}, (_, i) => `完成${i}`), batchCount: 70, completedBatches: 70}, "",
    {captionCount: pendingCount, store: waiting.store});
  assert.equal(finished.requests.queuePosts, 0, "a retry after reopening must reuse the queued job");
  assert.equal(finished.result.status, 200);

  return {
    googleQueueAndPostFallback: true,
    transientPollRecovery: true,
    savedJobReuse: true,
    staleTokenPublicRetry: true,
    completeQueueOnly: true,
    partialDirectFallback: true,
    boundedLongCaptionFallback: true,
    pendingJobSurvivesReopening: true,
    incompleteTranslationNeverMasqueradesAsComplete: true,
  };
}

(async () => {
  const worker = await loadWorker();
  const sourceResult = await verifySourceCaptions();
  const workerResult = await verifyWorkerQueue(worker);
  const clientResult = await verifyClientQueue();
  console.log(JSON.stringify({source: sourceResult, worker: workerResult, client: clientResult}, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
