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
  const markerPattern = new RegExp(`(\\n\\[\\[${marker}:\\d+\\]\\]\\n)`, "g");
  const exactMarkerPattern = new RegExp(`^\\n\\[\\[${marker}:\\d+\\]\\]\\n$`);
  const translated = query.split(markerPattern)
    .map((part) => (exactMarkerPattern.test(part) ? part : `譯:${part}`))
    .join("");
  return Response.json([[[translated, query]]]);
}

async function verifyWorkerQueue(worker) {
  const queuedBodies = [];
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
  const texts = Array.from({length: 1800}, (_, index) => (
    `Long caption ${index}: a sufficiently detailed sentence for queue batching and ordering checks.`
  ));
  const createResponse = await worker.default.fetch(new Request("https://worker.test/caption/jobs", {
    method: "POST",
    headers: {...authorization, "Content-Type": "application/json"},
    body: JSON.stringify({purpose: "captions", source: "en", target: "zh-Hant", texts}),
  }), env);
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.match(created.jobId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.itemCount, texts.length);
  assert(queuedBodies.length > 1, "long caption jobs must be split into multiple queue messages");

  const queuedCount = queuedBodies.length;
  const reusedResponse = await worker.default.fetch(new Request("https://worker.test/caption/jobs", {
    method: "POST",
    headers: {...authorization, "Content-Type": "application/json"},
    body: JSON.stringify({purpose: "captions", source: "en", target: "zh-Hant", texts}),
  }), env);
  assert.equal(reusedResponse.status, 202);
  const reused = await reusedResponse.json();
  assert.equal(reused.jobId, created.jobId, "identical subtitle payloads must reuse the same job");
  assert.equal(reused.reused, true);
  assert.equal(queuedBodies.length, queuedCount, "an in-progress reused job must not be enqueued twice");

  const publicStatus = await worker.default.fetch(
    new Request(`https://worker.test/caption/jobs/${created.jobId}`),
    env,
  );
  assert.equal(publicStatus.status, 200);
  const invalidAuthorization = await worker.default.fetch(new Request(
    `https://worker.test/caption/jobs/${created.jobId}`,
    {headers: {Authorization: "Bearer invalid-token"}},
  ), env);
  assert.equal(invalidAuthorization.status, 401);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const query = new URLSearchParams(options.body).get("q") || "";
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

  const publicReuseResponse = await worker.default.fetch(new Request("https://worker.test/caption/jobs", {
    method: "POST",
    headers: {"Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.8"},
    body: JSON.stringify({purpose: "captions", source: "en", target: "zh-Hant", texts}),
  }), env);
  assert.equal(publicReuseResponse.status, 200);
  const publicReuse = await publicReuseResponse.json();
  assert.equal(publicReuse.jobId, created.jobId);
  assert.equal(publicReuse.status, "complete");
  assert.equal(publicReuse.reused, true);

  const rateEnv = {
    CAPTION_ACCESS_TOKEN: accessToken,
    CAPTION_JOBS: new MockDurableObjectNamespace(worker.CaptionJob),
    CAPTION_QUEUE: {async sendBatch() {}},
  };
  const rateStatuses = [];
  for (let index = 0; index < 13; index++) {
    const response = await worker.default.fetch(new Request("https://worker.test/caption/jobs", {
      method: "POST",
      headers: {"Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9"},
      body: JSON.stringify({purpose: "captions", source: "en", target: "zh-Hant", texts: [`Rate ${index}`]}),
    }), rateEnv);
    rateStatuses.push(response.status);
  }
  assert.deepEqual(rateStatuses.slice(0, 12), new Array(12).fill(202));
  assert.equal(rateStatuses[12], 429);

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
  globalThis.fetch = async () => new Response("Unavailable", {status: 503});
  try {
    await worker.default.queue({messages: [retryMessage]}, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(retryMessage.acknowledged, false);
  assert.equal(retryMessage.retried, true);
  assert(retryMessage.retryOptions.delaySeconds >= 2);

  return {
    jobId: created.jobId,
    itemCount: texts.length,
    batchCount: queuedBodies.length,
    deterministicJobReuse: true,
    publicRateLimitedAccess: true,
    waitsForAllBatches: true,
    lateSuccessRecovery: true,
  };
}

function runCaptionClient(queueResult, captionToken = "") {
  const source = fs.readFileSync(clientPath, "utf8");
  const xml = '<?xml version="1.0"?><timedtext format="3"><body>'
    + '<p t="0" d="1000"><s>A</s></p><p t="1000" d="1000"><s>B</s></p>'
    + '<p t="2000" d="1000"><s>C</s></p></body></timedtext>';
  const requests = {queuePosts: 0, queuePolls: 0, googleGets: 0};
  const store = new Map();
  const jobId = "123e4567-e89b-42d3-a456-426614174000";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("caption client test timed out")), 8000);
    const context = {
      console,
      encodeURIComponent,
      decodeURIComponent,
      setTimeout,
      clearTimeout,
      $argument: JSON.stringify({captionToken, debug: false}),
      $request: {url: "https://www.youtube.com/api/timedtext?v=test&lang=en&enhance_tlang=zh-TW&format=srv3"},
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
            if (captionToken) assert.equal(request.headers.Authorization, `Bearer ${captionToken}`);
            else assert.equal(request.headers.Authorization, undefined);
            assert.deepEqual(JSON.parse(request.body).texts, ["A", "B", "C"]);
            callback(null, {status: 202}, JSON.stringify({jobId, pollAfterMs: 250}));
          } catch (error) {
            reject(error);
          }
        },
        get(request, callback) {
          try {
            if (request.url.startsWith("https://youtube-caption-translate.hmtw47cv7m.workers.dev/")) {
              requests.queuePolls++;
              callback(null, {status: 200}, JSON.stringify(queueResult));
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
        resolve({result, requests});
      },
    };
    try {
      vm.runInNewContext(source, context, {filename: clientPath});
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function verifyClientQueue() {
  const complete = await runCaptionClient({
    status: "complete",
    translations: ["隊列:A", "隊列:B", "隊列:C"],
    completedBatches: 1,
    batchCount: 1,
  });
  assert.equal(complete.requests.queuePosts, 1);
  assert.equal(complete.requests.queuePolls, 1);
  assert.equal(complete.requests.googleGets, 0);
  assert.match(complete.result.body, /隊列:A/);
  assert.match(complete.result.body, /隊列:B/);
  assert.match(complete.result.body, /隊列:C/);

  const partial = await runCaptionClient({
    status: "failed",
    translations: ["隊列:A", null, "隊列:C"],
    completedBatches: 1,
    failedBatches: 1,
    batchCount: 2,
  }, accessToken);
  assert.equal(partial.requests.queuePosts, 1);
  assert.equal(partial.requests.queuePolls, 1);
  assert.equal(partial.requests.googleGets, 1);
  assert.match(partial.result.body, /隊列:A/);
  assert.match(partial.result.body, /譯:B/);
  assert.match(partial.result.body, /隊列:C/);

  return {publicQueueByDefault: true, completeQueueOnly: true, partialDirectFallback: true};
}

(async () => {
  const worker = await loadWorker();
  const workerResult = await verifyWorkerQueue(worker);
  const clientResult = await verifyClientQueue();
  console.log(JSON.stringify({worker: workerResult, client: clientResult}, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
