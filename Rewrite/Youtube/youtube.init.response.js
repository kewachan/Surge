// Build: 2026-09-29 Surge direct-initplayback transform
(() => {
  const WORKER_URL = "https://youtube-init.hmtw47cv7m.workers.dev/transform";
  const CONFIG_KEY = "YouTubeConfig";
  const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
  const TRANSFORM_TIMEOUT_SECONDS = 18;

  const readParameters = () => {
    if (typeof $argument === "object" && $argument) return $argument;
    if (typeof $argument !== "string" || !$argument || $argument.includes("{{{")) return {};
    try {
      return JSON.parse($argument);
    } catch {
      return {};
    }
  };

  const parameters = readParameters();

  const finishUnchanged = (message) => {
    if (message && parameters.debug) console.log(`Youtube Enhance: ${message}`);
    $done({});
  };

  const headerValue = (headers, name) => {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers || {})) {
      if (key.toLowerCase() === target) return String(headers[key] || "");
    }
    return "";
  };

  const statusCode = (response) => {
    const value = response?.status ?? response?.statusCode ?? 0;
    if (typeof value === "number") return value;
    const match = String(value).match(/\b(\d{3})\b/);
    return match ? Number(match[1]) : 0;
  };

  const toBytes = (value) => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  };

  const captionLanguage = () => {
    const value = String(parameters.captionLang ?? "off").trim();
    if (/^(?:on|true)$/i.test(value)) return "zh-Hant";
    if (!value || /^off$/i.test(value) || value.length > 32) return "off";
    return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(value) ? value : "off";
  };

  try {
    const contentType = headerValue($response?.headers, "content-type").toLowerCase();
    const originalBody = toBytes($response?.body ?? $response?.bodyBytes);
    if (statusCode($response) !== 200 || !contentType.includes("application/vnd.yt-ump") || !originalBody?.length) {
      finishUnchanged();
      return;
    }
    if (originalBody.length > MAX_RESPONSE_BYTES) {
      finishUnchanged("initplayback response is too large; preserving the original response");
      return;
    }

    let config;
    try {
      config = JSON.parse($persistentStore.read(CONFIG_KEY) || "{}");
    } catch {
      finishUnchanged("saved key state is invalid; preserving the original response");
      return;
    }

    const userAgent = headerValue($request?.headers, "user-agent").toLowerCase();
    const platformKey = userAgent.includes("music") ? "youtubeMusic" : "youtube";
    const clientKey = config?.[platformKey]?.clientKey;
    if (typeof clientKey !== "string" || !clientKey || clientKey.length > 64) {
      finishUnchanged("no matching client key; preserving the original response");
      return;
    }

    const url = `${WORKER_URL}?ck=${encodeURIComponent(clientKey)}&captionLang=${encodeURIComponent(captionLanguage())}`;
    $httpClient.post({
      url,
      timeout: TRANSFORM_TIMEOUT_SECONDS,
      alpn: "h2",
      headers: {
        "Content-Type": "application/vnd.yt-ump",
        Accept: "application/vnd.yt-ump",
      },
      body: originalBody,
      "binary-mode": true,
    }, (error, response, data) => {
      const transformedBody = toBytes(data);
      const transformedType = headerValue(response?.headers, "content-type").toLowerCase();
      if (error || statusCode(response) !== 200 || !transformedType.includes("application/vnd.yt-ump") || !transformedBody?.length) {
        finishUnchanged("Worker transform failed; preserving the original response");
        return;
      }
      $done({body: transformedBody});
    });
  } catch (error) {
    finishUnchanged(`unexpected transform error: ${error?.message || String(error)}`);
  }
})();
