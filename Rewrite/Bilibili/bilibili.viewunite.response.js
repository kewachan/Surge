/*
 * Bilibili AIRelateAsync ad filtering — v1.0.0
 * The captured replies put ad modules at 1 -> 5 -> 1 (protobuf Any), with
 * type.googleapis.com/bilibili.ad.v1.SourceContentDto as their type URL.
 * Remove only those modules; preserve other fields and unmodified frames.
 */
(function () {
  'use strict';

  const AD_TYPE = 'type.googleapis.com/bilibili.ad.v1.SourceContentDto';
  const ENDPOINT = /^https?:\/\/(?:grpc|app)\.bili(?:bili\.com|api\.net)\/bilibili\.app\.viewunite\.v1\.View\/AIRelateAsync(?:\?.*)?$/;
  const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

  function argumentsMap(value) {
    const result = Object.create(null);
    if (value && typeof value === 'object') return value;
    for (const part of String(value || '').split('&')) {
      const at = part.indexOf('=');
      if (at < 0) continue;
      const key = decodeURIComponent(part.slice(0, at));
      let item = decodeURIComponent(part.slice(at + 1).replace(/\+/g, ' ')).trim();
      if ((item[0] === '"' || item[0] === "'") && item.at(-1) === item[0]) item = item.slice(1, -1);
      result[key] = item;
    }
    return result;
  }

  function varint(bytes, offset) {
    let value = 0;
    let multiplier = 1;
    for (let count = 0; count < 5; count++) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf value');
      const byte = bytes[offset++];
      value += (byte & 0x7f) * multiplier;
      if (!(byte & 0x80)) return [value, offset];
      multiplier *= 128;
    }
    throw new Error('Oversized protobuf tag or length');
  }

  function fields(bytes) {
    const result = [];
    let offset = 0;
    while (offset < bytes.length) {
      const start = offset;
      let tag;
      [tag, offset] = varint(bytes, offset);
      const number = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!number || number > 0x1fffffff) throw new Error('Invalid protobuf field');
      let dataStart = offset;
      if (wire === 0) {
        let count = 0;
        while (true) {
          if (offset >= bytes.length || count++ === 10) throw new Error('Invalid protobuf integer');
          if (!(bytes[offset++] & 0x80)) break;
        }
      } else if (wire === 1) offset += 8;
      else if (wire === 2) {
        let size;
        [size, offset] = varint(bytes, offset);
        dataStart = offset;
        offset += size;
      } else if (wire === 5) offset += 4;
      else throw new Error('Unsupported protobuf wire type');
      if (offset > bytes.length) throw new Error('Truncated protobuf field');
      result.push({number, wire, start, dataStart, end: offset});
    }
    return result;
  }

  function data(bytes, field) { return bytes.subarray(field.dataStart, field.end); }
  function raw(bytes, field) { return bytes.subarray(field.start, field.end); }
  function join(parts) {
    const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
  }

  function encodeVarint(value) {
    const output = [];
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value) byte |= 0x80;
      output.push(byte);
    } while (value);
    return Uint8Array.from(output);
  }

  function message(number, value) {
    return join([encodeVarint(number * 8 + 2), encodeVarint(value.length), value]);
  }

  function isAdModule(bytes) {
    for (const field of fields(bytes)) {
      if (field.number !== 1 || field.wire !== 2) continue;
      const any = data(bytes, field);
      const items = fields(any);
      const type = items.find(item => item.number === 1 && item.wire === 2);
      const value = items.find(item => item.number === 2 && item.wire === 2);
      if (!type || !value || value.end === value.dataStart) continue;
      const name = data(any, type);
      if (name.length === AD_TYPE.length && name.every((byte, index) => byte === AD_TYPE.charCodeAt(index))) return true;
    }
    return false;
  }

  function filterMessage(bytes) {
    let removed = 0;
    const output = fields(bytes).map(field => {
      if (field.number !== 1 || field.wire !== 2) return raw(bytes, field);
      const container = data(bytes, field);
      let changed = false;
      const kept = fields(container).filter(item => {
        if (item.number !== 5 || item.wire !== 2 || !isAdModule(data(container, item))) return true;
        removed++;
        changed = true;
        return false;
      }).map(item => raw(container, item));
      return changed ? message(field.number, join(kept)) : raw(bytes, field);
    });
    return {bytes: removed ? join(output) : bytes, removed};
  }

  function filterFrames(bytes, encoding) {
    let offset = 0;
    let removed = 0;
    const output = [];
    while (offset < bytes.length) {
      if (offset + 5 > bytes.length) throw new Error('Truncated gRPC frame');
      const start = offset;
      const compressed = bytes[offset];
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
      offset += 5;
      if (compressed > 1 || offset + size > bytes.length || size > MAX_MESSAGE_BYTES) throw new Error('Invalid gRPC frame');
      let payload = bytes.subarray(offset, offset + size);
      offset += size;
      if (compressed) {
        if (encoding !== 'gzip' || typeof $utils === 'undefined' || typeof $utils.ungzip !== 'function') {
          throw new Error('gzip decompression unavailable');
        }
        payload = $utils.ungzip(payload);
        if (!(payload instanceof Uint8Array) || payload.length > MAX_MESSAGE_BYTES) throw new Error('Invalid gzip payload');
      }
      const filtered = filterMessage(payload);
      removed += filtered.removed;
      if (!filtered.removed) { output.push(bytes.subarray(start, offset)); continue; }
      // The gRPC compression flag is per message: flag 0 is valid even when
      // grpc-encoding is gzip. No recompression or transport-header changes.
      const header = new Uint8Array(5);
      new DataView(header.buffer).setUint32(1, filtered.bytes.length, false);
      output.push(header, filtered.bytes);
    }
    return {bytes: removed ? join(output) : bytes, removed};
  }

  try {
    if (!ENDPOINT.test($request.url) || Number($response.status ?? $response.statusCode ?? 200) !== 200) return $done({});
    const options = argumentsMap(typeof $argument === 'undefined' ? '' : $argument);
    if (options['View.AD'] !== undefined && !/^(true|1)$/i.test(String(options['View.AD']))) return $done({});
    const body = $response.body;
    if (!(body instanceof Uint8Array) || body.length === 0) return $done({});
    const headers = $response.headers || {};
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'grpc-encoding');
    const result = filterFrames(body, String(key ? headers[key] : 'identity').trim().toLowerCase());
    if (result.removed && /^(INFO|DEBUG|ALL)$/i.test(String(options.LogLevel || ''))) {
      console.log(`Bilibili AIRelateAsync: removed ${result.removed} ad modules`);
    }
    return $done(result.removed ? {body: result.bytes} : {});
  } catch (error) {
    console.log(`Bilibili AIRelateAsync: kept original response (${error.message})`);
    return $done({});
  }
})();
