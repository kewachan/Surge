const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vendor = path.join(__dirname, "Vendor/OpenCC");
const provenance = JSON.parse(fs.readFileSync(path.join(vendor, "provenance.json"), "utf8"));
for (const [name, expected] of Object.entries(provenance.files)) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(vendor, name))).digest("hex");
  if (actual !== expected) throw new Error(`Vendored OpenCC file changed: ${name}`);
}
const file = path.join(__dirname, "youtube.lyrics.js");
const begin = "// BEGIN LOCAL CHINESE CONVERSION\n";
const end = "// END LOCAL CHINESE CONVERSION\n";
let body = fs.readFileSync(file, "utf8");
if (body.startsWith(begin)) {
  const index = body.indexOf(end);
  if (index < 0) throw new Error("Malformed Chinese conversion bundle");
  body = body.slice(index + end.length);
}
const library = fs.readFileSync(path.join(vendor, "opencc.js"), "utf8");
const policy = fs.readFileSync(path.join(__dirname, "youtube.chinese.js"), "utf8").replace(/^export /gm, "");
const prefix = `(() => {
// opencc-js 1.4.2: MIT; bundled dictionary data: Apache-2.0. See Vendor/OpenCC.
const OpenCC = (() => { const exports = {}, module = {exports};
${library}
return module.exports; })();
${policy}
let traditional, simplified;
globalThis.YouTubeChinese = {
  isLine: chineseLyricLine,
  enabled: chineseConversionEnabled,
  convert(text, target) {
    const script = chineseTarget(target);
    if (script === "t") return (traditional ||= OpenCC.Converter({from: "cn", to: "t"}))(text);
    if (script === "cn") return (simplified ||= OpenCC.Converter({from: "t", to: "cn"}))(text);
    return text;
  }
};
})();
`;
const output = `${begin}${prefix}${end}${body}`;
if (process.argv.includes("--check")) {
  if (fs.readFileSync(file, "utf8") !== output) throw new Error("Chinese conversion bundle is stale; run build-lyrics-chinese.cjs");
} else fs.writeFileSync(file, output);
