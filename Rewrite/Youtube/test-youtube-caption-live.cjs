const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {spawn} = require("node:child_process");

const harPath = process.env.CAPTION_HAR_PATH;
if (!harPath) throw new Error("Set CAPTION_HAR_PATH to a retained HAR containing source srv3 captions");
const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
const entry = har.log.entries.find((entry) => {
  if (!entry.request.url.includes("/api/timedtext?") || entry.response.status !== 200) return false;
  const url = new URL(entry.request.url);
  return (!process.env.CAPTION_VIDEO_ID || url.searchParams.get("v") === process.env.CAPTION_VIDEO_ID)
    && !url.searchParams.has("tlang");
});
assert(entry, "HAR must contain a successful original caption response");
const content = entry.response.content;
const originalBody = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
assert(originalBody.includes("<timedtext"));
const source = fs.readFileSync(path.join(__dirname, "youtube.caption.js"), "utf8");
const timers = new Set();
const store = new Map();
let rewritten;
const sourceUrl = new URL(entry.request.url);
sourceUrl.searchParams.set("tlang", "zh-Hant");
vm.runInNewContext(source, {
  console, encodeURIComponent, decodeURIComponent,
  $request: {url: sourceUrl.toString()},
  $done(result) { rewritten = result.url; },
});
assert(!new URL(rewritten).searchParams.has("tlang"));

function runClient() {
  const requests = new Set();
  const counts = {jobPosts: 0, jobPolls: 0, googlePosts: 0};
  const started = Date.now();
  let finished = false;
  return new Promise((resolve, reject) => {
    function cleanup() {
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const child of requests) child.kill("SIGTERM");
    }
    function request(method, options, callback) {
      const host = new URL(options.url).hostname;
      assert(["youtube-caption-translate.hmtw47cv7m.workers.dev", "translate.googleapis.com", "translate.google.com"].includes(host));
      if (host.includes("workers.dev")) counts[method === "POST" ? "jobPosts" : "jobPolls"]++;
      else counts.googlePosts++;
      const args = ["-sS", "--max-time", String(Number(options.timeout) || 5), "-X", method, "-w", "\n%{http_code}", options.url];
      for (const [name, value] of Object.entries(options.headers || {})) args.push("-H", `${name}: ${value}`);
      if (options.body) args.push("--data-binary", "@-");
      const child = spawn("/usr/bin/curl", args, {stdio: ["pipe", "pipe", "pipe"]});
      requests.add(child);
      let output = "", error = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("close", (code) => {
        requests.delete(child);
        if (finished) return;
        if (code !== 0) callback(error || "HTTP request failed");
        else {
          const split = output.lastIndexOf("\n");
          callback(null, {status: Number(output.slice(split + 1)), headers: {}}, output.slice(0, split));
        }
      });
      child.stdin.end(options.body || "");
    }
    const guard = setTimeout(() => { cleanup(); reject(new Error("Caption client exceeded the app request budget")); }, 8000);
    timers.add(guard);
    vm.runInNewContext(source, {
      console, encodeURIComponent, decodeURIComponent,
      setTimeout(callback, delay) {
        const timer = setTimeout(() => { timers.delete(timer); if (!finished) callback(); }, delay);
        timers.add(timer);
        return timer;
      },
      clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
      $argument: JSON.stringify({debug: false}),
      $request: {url: rewritten},
      $response: {status: 200, body: originalBody, headers: {"Content-Type": "text/xml", "Content-Encoding": "gzip"}},
      $persistentStore: {
        read(key) { return store.get(key) || null; },
        write(value, key) { value ? store.set(key, value) : store.delete(key); return true; },
      },
      $httpClient: {
        get: (options, callback) => request("GET", options, callback),
        post: (options, callback) => request("POST", options, callback),
      },
      $done(result) {
        if (finished) return;
        cleanup();
        resolve({result, counts, ms: Date.now() - started});
      },
    }, {filename: "youtube.caption.js"});
  });
}

(async () => {
  let run = await runClient();
  const first = {status: run.result.status, ms: run.ms, counts: run.counts};
  const deadline = Date.now() + 60000;
  let retries = 0;
  while (run.result.status === 503 && Date.now() < deadline) {
    assert.equal(run.result.headers["X-YouTube-Caption-State"], "pending");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const savedJob = [...store.keys()].some((key) => key.startsWith("YouTubeCaption.Job.v20."));
    run = await runClient();
    retries++;
    if (savedJob) assert.equal(run.counts.jobPosts, 0, "a reopened client must reuse its persistent job");
  }
  assert.equal(run.result.status, 200, "live Google caption translation must finish");
  assert.equal(run.result.headers["X-YouTube-Caption-State"], "complete");
  assert(!Object.keys(run.result.headers).some((key) => key.toLowerCase() === "content-encoding"));
  const sourceParagraphs = [...originalBody.matchAll(/<p(\s[^>]*)?>/g)].map((match) => match[1] || "");
  const outputParagraphs = [...run.result.body.matchAll(/<p(\s[^>]*)?>/g)].map((match) => match[1] || "");
  assert.deepEqual(outputParagraphs, sourceParagraphs, "every caption timestamp and paragraph attribute must be retained");
  const text = run.result.body.replace(/<[^>]*>/g, "");
  assert(!/[\u0e00-\u0e7f]/.test(text), "translated Thai captions must not contain untranslated Thai lines");
  assert(/[\u3400-\u9fff]/.test(text));
  const cached = await runClient();
  assert.equal(cached.result.status, 200);
  assert.equal(cached.counts.jobPosts, 0);
  assert.equal(cached.counts.googlePosts, 0);
  console.log(JSON.stringify({video: new URL(entry.request.url).searchParams.get("v"), first, retries,
    final: {status: run.result.status, ms: run.ms, paragraphs: outputParagraphs.length, thaiRemaining: 0},
    reopened: {status: cached.result.status, ms: cached.ms, counts: cached.counts}}, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
