const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "youtube.response.js");
const begin = "// BEGIN YOUTUBE PREWARM BOOTSTRAP\n";
const end = "// END YOUTUBE PREWARM BOOTSTRAP\n";
let body = fs.readFileSync(file, "utf8");
if (body.startsWith(begin)) {
  const index = body.indexOf(end);
  if (index < 0) throw new Error("Malformed prewarm bootstrap");
  body = body.slice(index + end.length);
}
const original = "function Rr(l,e){xi(l),Wi(l),Si(l,e)}";
const previous = "function Rr(l,e){globalThis.YouTubePrewarm?.capture(l,Vi());xi(l),Wi(l),Si(l,e)}";
const updated = "function Rr(l,e){globalThis.YouTubePrewarm?.capture(l,Vi(),d.list(l));xi(l),Wi(l),Si(l,e)}";
if (body.includes(original)) body = body.replace(original, updated);
if (body.includes(previous)) body = body.replace(previous, updated);
if (body.split(updated).length !== 2) throw new Error("Upstream player handler changed; review the capture hook");
const helper = fs.readFileSync(path.join(__dirname, "youtube.prewarm.client.js"), "utf8");
const responseOutput = `${begin}${helper}\n${end}${body}`;
const initFile = path.join(__dirname, "youtube.init.response.js");
let init = fs.readFileSync(initFile, "utf8");
if (init.startsWith(begin)) {
  const index = init.indexOf(end);
  if (index < 0) throw new Error("Malformed init prewarm bootstrap");
  init = init.slice(index + end.length);
}
const initOutput = `${begin}${helper}\n${end}${init}`;
if (process.argv.includes("--check")) {
  if (fs.readFileSync(file, "utf8") !== responseOutput || fs.readFileSync(initFile, "utf8") !== initOutput) {
    throw new Error("Prewarm bundles are stale; run build-prewarm.cjs");
  }
} else {
  fs.writeFileSync(file, responseOutput);
  fs.writeFileSync(initFile, initOutput);
}
