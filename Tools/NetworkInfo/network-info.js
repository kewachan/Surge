(function () {
  "use strict";

  const NAME = "Network Info";
  const DEFAULTS = {
    proxyEndpoint: "https://api-ipv4.ip.sb/ip",
    timeout: 5,
    retries: 1,
    retryDelay: 1,
    icon: "network",
    iconColor: "#6699FF"
  };

  const options = parseArguments(
    typeof $argument === "string" ? $argument : ""
  );

  run()
    .then($done)
    .catch(error => {
      console.log(`[${NAME}] ${messageFor(error)}`);
      $done({
        title: "Network information unavailable",
        content: messageFor(error),
        style: "error"
      });
    });

  async function run() {
    const proxy = await lookup(options.proxyEndpoint);

    return {
      title: countryName(proxy.countryCode),
      content: `Provider: ${proxy.provider}\nPublic IP: ${proxy.ip}`,
      icon: options.icon,
      "icon-color": options.iconColor
    };
  }

  function parseArguments(raw) {
    const values = {};

    String(raw).split("&").forEach(part => {
      const separator = part.indexOf("=");
      if (separator < 1) return;

      const key = part.slice(0, separator).trim();
      let value = part.slice(separator + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch (_) {}
      values[key] = value;
    });

    return {
      proxyEndpoint: validEndpoint(values.proxy_endpoint, DEFAULTS.proxyEndpoint),
      timeout: boundedInteger(values.timeout, DEFAULTS.timeout, 1, 30),
      retries: boundedInteger(values.retries, DEFAULTS.retries, 0, 5),
      retryDelay: boundedInteger(values.retry_delay, DEFAULTS.retryDelay, 0, 10),
      icon: values.icon || DEFAULTS.icon,
      iconColor: validColor(values.icon_color, DEFAULTS.iconColor)
    };
  }

  function validEndpoint(value, fallback) {
    const endpoint = String(value || "").trim();
    return /^https?:\/\/[^\s]+$/i.test(endpoint) ? endpoint : fallback;
  }

  function validColor(value, fallback) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  async function lookup(endpoint) {
    let lastError;

    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      try {
        const ip = await fetchIPv4(endpoint);
        return enrich(ip);
      } catch (error) {
        lastError = error;
        if (attempt >= options.retries) break;
        console.log(
          `[${NAME}] Lookup failed; retrying ` +
          `(${attempt + 1}/${options.retries}): ${messageFor(error)}`
        );
        await delay(options.retryDelay * 1000);
      }
    }

    throw new Error(`Public IP lookup failed: ${messageFor(lastError)}`);
  }

  function fetchIPv4(url) {
    return new Promise((resolve, reject) => {
      $httpClient.get({
        url,
        timeout: options.timeout,
        headers: { Accept: "text/plain" }
      }, (error, response, data) => {
        if (error) {
          reject(new Error(String(error)));
          return;
        }

        const status = Number(response && (response.status || response.statusCode));
        if (!Number.isFinite(status) || status < 200 || status >= 300) {
          reject(new Error(`HTTP ${Number.isFinite(status) ? status : "error"}`));
          return;
        }

        const ip = String(data || "").trim();
        if (!isIPv4(ip)) {
          reject(new Error("The endpoint returned an invalid IPv4 address"));
          return;
        }

        resolve(ip);
      });
    });
  }

  function isIPv4(value) {
    const parts = String(value).split(".");
    return parts.length === 4 && parts.every(part => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const number = Number(part);
      return number >= 0 && number <= 255 && String(number) === part;
    });
  }

  function enrich(ip) {
    let countryCode = "";
    let provider = "Unknown";

    try {
      countryCode = String($utils.geoip(ip) || "").trim().toUpperCase();
    } catch (_) {}

    try {
      provider = cleanProvider($utils.ipaso(ip));
    } catch (_) {}

    return { ip, countryCode, provider };
  }

  function cleanProvider(value) {
    const provider = String(value || "").trim().replace(/^AS\d+\s*/i, "");
    return provider || "Unknown";
  }

  function countryName(countryCode) {
    if (!/^[A-Z]{2}$/.test(countryCode)) return "Unknown Country";

    try {
      if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
        const name = new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode);
        if (name && name !== countryCode) return name;
      }
    } catch (_) {}

    return countryCode;
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function messageFor(error) {
    return error && error.message ? error.message : String(error || "Unknown error");
  }
})();
