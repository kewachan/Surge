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
  globalThis.fetch = async (url) => {
    googleRuns++;
    const query = new URL(url).searchParams.get("q") || "";
    return translatedGoogleResponse(query);
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

  return {
    jobId: created.jobId,
    itemCount: texts.length,
    batchCount: queuedBodies.length,
    publicRateLimitedAccess: true,
    deterministicJobDedupe: true,
    googleTranslateOnly: true,
    googleRateLimitRetry: true,
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
  const requests = {nativeGets: 0, queuePosts: 0, queuePolls: 0, googleGets: 0, rejectedAuthorization: 0};
  const store = options.store || new Map();
  const jobId = "123e4567-e89b-42d3-a456-426614174000";
  const queuedResults = Array.isArray(queueResults) ? queueResults : [queueResults];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("caption client test timed out")), 8000);
    const context = {
      console,
      encodeURIComponent,
      decodeURIComponent,
      setTimeout,
      clearTimeout,
      $argument: JSON.stringify({captionToken, debug: false}),
      $request: {url: options.url || "https://www.youtube.com/api/timedtext?v=test&lang=en&enhance_tlang=zh-TW&format=srv3"},
      $response: {body: xml, headers: {"Content-Type": "text/xml"}},
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
            requests.queuePosts++;
            assert.equal(request.url, "https://youtube-caption-translate.hmtw47cv7m.workers.dev/caption/jobs");
            if (request.headers.Authorization) {
              assert.equal(request.headers.Authorization, `Bearer ${captionToken}`);
            }
            assert.deepEqual(JSON.parse(request.body).texts, captionTexts);
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
              requests.nativeGets++;
              assert.equal(request.timeout, options.loon ? 3000 : 3);
              const url = new URL(request.url);
              assert.equal(url.searchParams.get("tlang"), "zh-Hant");
              assert.equal(url.searchParams.has("enhance_tlang"), false);
              if (options.nativeBody) callback(null, {status: 200, headers: {"Content-Type": "text/xml", "Content-Length": "1"}}, options.nativeBody);
              else callback(null, {status: 429}, "Native captions unavailable in this fallback test");
              return;
            }
            if (request.url.startsWith("https://youtube-caption-translate.hmtw47cv7m.workers.dev/")) {
              requests.queuePolls++;
              const queueResult = queuedResults[Math.min(requests.queuePolls - 1, queuedResults.length - 1)];
              if (queueResult instanceof Error) callback(queueResult);
              else callback(null, {status: 200}, JSON.stringify(queueResult));
              return;
            }
            requests.googleGets++;
            const url = new URL(request.url);
            const query = url.searchParams.get("q") || "";
            translatedGoogleResponse(query, "YTS").text().then((body) => callback(null, {status: 200}, body), reject);
          } catch (error) {
            reject(error);
          }
        },
      },
      $done(result) {
        clearTimeout(timer);
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

async function verifyNativeCaptions() {
  const base = "https://www.youtube.com/api/timedtext?v=test&lang=th&signature=a%2Bb%2Fc&fmt=srv3";
  assert.equal(rewrittenCaptionUrl(`${base}&tlang=zh-Hant`), `${base}&tlang=zh-Hant`);
  assert.equal(rewrittenCaptionUrl(`${base}&tlang=zh-TW`), `${base}&tlang=zh-Hant`);
  assert.equal(rewrittenCaptionUrl(`${base}&enhance_tlang=zh-TW`), `${base}&tlang=zh-Hant`);
  assert.equal(rewrittenCaptionUrl(`${base}&tlang=zh-CN#caption`), `${base}&tlang=zh-Hans#caption`);
  assert.equal(rewrittenCaptionUrl(`${base}&enhance_tlang=zh-TW&tlang=ja`), `${base}&tlang=ja`);
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

  const translated = '<?xml version="1.0"?><timedtext format="3"><body><p t="0" d="1000"><s>完整的繁體中文字幕。</s></p></body></timedtext>';
  const recovered = await runCaptionClient(null, "", {nativeBody: translated});
  assert.equal(recovered.result.body, translated);
  assert.equal(recovered.requests.nativeGets, 1);
  assert.equal(recovered.requests.queuePosts, 0);
  assert.equal(recovered.requests.googleGets, 0);
  assert.equal(recovered.result.headers["Content-Length"], undefined);

  const loonRecovered = await runCaptionClient(null, "", {nativeBody: translated, loon: true});
  assert.equal(loonRecovered.result.body, translated);
  assert.equal(loonRecovered.requests.nativeGets, 1);
  assert.equal(loonRecovered.requests.queuePosts, 0);

  let harRequests = 0;
  if (process.env.CAPTION_HAR_PATH) {
    const har = JSON.parse(fs.readFileSync(process.env.CAPTION_HAR_PATH, "utf8"));
    for (const entry of har.log.entries) {
      if (!entry.request.url.includes("/api/timedtext?") || entry.response.status !== 200) continue;
      const content = entry.response.content;
      const body = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
      const url = rewrittenCaptionUrl(entry.request.url);
      assert.equal(new URL(url).searchParams.has("enhance_tlang"), false);
      assert.equal(new URL(url).searchParams.get("tlang"), "zh-Hant");
      const replay = await runCaptionClient(null, "", {url, body});
      assert.equal(Object.keys(replay.result).length, 0);
      assert.equal(Object.values(replay.requests).reduce((a, b) => a + b, 0), 0);
      harRequests++;
    }
    assert(harRequests > 0, "HAR regression input must include caption requests");
  }
  return {nativeTargetPreserved: true,legacyUrlMigration: true,longCaptionQueueBypass: true,
    nativeFormatsPreserved: true,legacyNativeRecovery: true,loonNativeRecovery: true,harRequestRegressions: harRequests};
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
  ], "", {store: sharedStore});
  assert.equal(complete.requests.queuePosts, 1);
  assert.equal(complete.requests.queuePolls, 3);
  assert.equal(complete.requests.googleGets, 0);
  assert.match(complete.result.body, /隊列:A/);
  assert.match(complete.result.body, /隊列:B/);
  assert.match(complete.result.body, /隊列:C/);
  assert([...sharedStore.keys()].some((key) => key.startsWith("YouTubeCaption.Job.v19.")));

  for (const key of [...sharedStore.keys()]) {
    if (key.startsWith("YouTubeCaption.v5.") || key === "YouTubeCaption.CacheIndex.v5") {
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
  assert.equal(reusedJob.requests.googleGets, 0);
  assert.match(reusedJob.result.body, /重用:A/);

  const staleToken = await runCaptionClient({
    status: "complete",
    translations: ["隊列:A", "隊列:B", "隊列:C"],
    completedBatches: 1,
    batchCount: 1,
  }, accessToken, {rejectAuthorizedOnce: true});
  assert.equal(staleToken.requests.queuePosts, 2);
  assert.equal(staleToken.requests.rejectedAuthorization, 1);
  assert.equal(staleToken.requests.googleGets, 0);

  const partial = await runCaptionClient({
    status: "failed",
    translations: ["隊列:A", null, "隊列:C"],
    completedBatches: 1,
    failedBatches: 1,
    batchCount: 2,
  });
  assert.equal(partial.requests.queuePosts, 1);
  assert.equal(partial.requests.queuePolls, 1);
  assert.equal(partial.requests.googleGets, 1);
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
  assert.equal(longFailure.requests.googleGets, 0, "long captions must not start another direct request storm");
  assert.match(longFailure.result.body, /Caption 161/);

  return {
    legacyQueueFallback: true,
    transientPollRecovery: true,
    savedJobReuse: true,
    staleTokenPublicRetry: true,
    completeQueueOnly: true,
    partialDirectFallback: true,
    longCaptionNoDirectStorm: true,
  };
}

(async () => {
  const worker = await loadWorker();
  const nativeResult = await verifyNativeCaptions();
  const workerResult = await verifyWorkerQueue(worker);
  const clientResult = await verifyClientQueue();
  console.log(JSON.stringify({native: nativeResult, worker: workerResult, client: clientResult}, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
