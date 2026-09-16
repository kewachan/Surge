/**
 * LINE AdBlock for Surge — v1.0.0
 * Disables the server-controlled News tab without blocking LINE's shared
 * configuration endpoint.
 */

(function () {
  "use strict";

  const KEY = "function.maintab.newsrowtab.enable";
  const YES = 0x59;
  const NO = 0x4e;

  function asciiBytes(text) {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index);
    }
    return bytes;
  }

  function matchesAt(body, needle, offset) {
    if (offset + needle.length > body.length) return false;
    for (let index = 0; index < needle.length; index += 1) {
      if (body[offset + index] !== needle[index]) return false;
    }
    return true;
  }

  if (Number($response.status) !== 200 || !($response.body instanceof Uint8Array)) {
    $done({});
    return;
  }

  const body = $response.body;
  const key = asciiBytes(KEY);
  let output = null;

  for (let offset = 0; offset <= body.length - key.length - 2; offset += 1) {
    if (offset === 0 || body[offset - 1] !== key.length ||
        !matchesAt(body, key, offset)) continue;

    const valueLengthOffset = offset + key.length;
    const valueOffset = valueLengthOffset + 1;

    // The captured getConfigurations Thrift map stores this flag as a
    // one-byte string. Leave unknown future encodings untouched.
    if (body[valueLengthOffset] !== 0x01 || body[valueOffset] !== YES) continue;

    if (output === null) output = new Uint8Array(body);
    output[valueOffset] = NO;
  }

  $done(output === null ? {} : { body: output });
})();
