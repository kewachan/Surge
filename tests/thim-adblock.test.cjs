// Run: node tests/thim-adblock.test.cjs [path/to/THIM.har]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "Rewrite/GeneralAdBlock/thim-adblock.js"),
  "utf8"
);
const script = new vm.Script(source, { filename: "thim-adblock.js" });
const url = "https://service.thim.immigration.go.th/api/v1/explore/coupons/exclusive-banners";

function run(body, overrides = {}) {
  let result;
  let calls = 0;
  const context = {
    $request: { method: "GET", url, ...overrides.request },
    $response: { status: 200, body, ...overrides.response },
    $done(value) {
      calls++;
      result = value;
    }
  };
  script.runInNewContext(context, { timeout: 1000 });
  assert.equal(calls, 1);
  return result;
}

function passthrough(result) {
  assert.deepEqual(Object.keys(result), []);
}

const fixture = {
  code: "200.00",
  status: "SUCCESS",
  message: "Success",
  data: [{ id: "B001", imageUrl: "https://assets.example/1" }],
  untouched: { keep: true }
};

const modified = JSON.parse(run(JSON.stringify(fixture)).body);
assert.deepEqual(modified.data, []);
assert.deepEqual(modified.untouched, fixture.untouched);
assert.equal(modified.code, fixture.code);
assert.equal(modified.status, fixture.status);

passthrough(run(JSON.stringify(fixture), { request: { url: url + "/other" } }));
passthrough(run(JSON.stringify(fixture), { request: { method: "POST" } }));
passthrough(run(JSON.stringify(fixture), { response: { status: 304 } }));
passthrough(run("not-json"));
passthrough(run(JSON.stringify({ ...fixture, data: [] })));
passthrough(run(JSON.stringify({ ...fixture, data: {} })));
passthrough(run(JSON.stringify({ ...fixture, status: "ERROR" })));

const moduleText = fs.readFileSync(
  path.join(root, "Rewrite/GeneralAdBlock/GeneralAdBlock.sgmodule"),
  "utf8"
);
const thimLines = moduleText.split("\n").filter(line => line.startsWith("THIM = "));
assert.equal(thimLines.length, 1);
assert(thimLines[0].includes("/thim-adblock.js?v=1.0.0"));
const pattern = new RegExp(thimLines[0].match(/pattern=(.*?), /)[1]);
assert(pattern.test(url));
assert(pattern.test(url + "?language=en"));
assert(!pattern.test(url + "/other"));
assert(!pattern.test("https://service.thim.immigration.go.th/api/v1/trip/trips"));
assert(moduleText.includes("service.thim.immigration.go.th"));

if (process.argv[2]) {
  const har = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const entry = har.log.entries.find(item => item.request.url === url);
  assert(entry, "exclusive-banners response not found in HAR");
  const original = JSON.parse(entry.response.content.text);
  assert.equal(original.data.length, 5);
  assert.equal(original.data[2].id, "B003");
  const output = JSON.parse(run(entry.response.content.text).body);
  assert.deepEqual(output, { ...original, data: [] });
  console.log("Actual THIM.har response: 5 exclusive banners -> 0; envelope preserved");
}

console.log("THIM AdBlock tests passed");
