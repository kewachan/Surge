(function () {
  "use strict";

  const NAME = "Network Interface Info";
  const STORE_KEY = "network_interface_info_daily_v1";
  const SECTION_KEYS = ["wifi", "cellular"];
  const METRICS = ["out", "in", "outCurrentSpeed", "inCurrentSpeed"];
  const options = parseArguments(
    typeof $argument === "string" ? $argument : ""
  );

  run()
    .then(result => {
      if (options.mode === "panel") {
        $done(result);
      } else {
        $done();
      }
    })
    .catch(error => {
      console.log(`[${NAME}] ${messageFor(error)}`);
      if (options.mode === "panel") {
        $done({
          title: NAME,
          content: `Traffic data unavailable.\n${messageFor(error)}`,
          style: "error"
        });
      } else {
        $done();
      }
    });

  async function run() {
    const interfaces = await getInterfaces();
    const snapshot = createSnapshot(interfaces);
    const today = dateKey(new Date());

    if (options.mode === "reset") {
      saveState(createState(today, snapshot, false));
      console.log(`[${NAME}] Daily statistics reset for ${today}`);
      return null;
    }

    const state = updateState(loadState(), today, snapshot);
    saveState(state);

    if (options.mode === "sample") {
      console.log(`[${NAME}] Daily speed sample recorded for ${today}`);
      return null;
    }

    return {
      title: NAME,
      content: [
        formatSection("Wi-Fi", "wifi", state),
        formatSection("Cellular", "cellular", state)
      ].join("\n\n"),
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
      mode: values.mode === "sample" || values.mode === "reset"
        ? values.mode
        : "panel",
      style: values.style === "normal" ? "normal" : "compact",
      icon: values.icon || "wifi.router",
      iconColor: /^#[0-9a-f]{6}$/i.test(values.icon_color || "")
        ? values.icon_color
        : "#6699FF"
    };
  }

  function getInterfaces() {
    return new Promise((resolve, reject) => {
      try {
        $httpAPI("GET", "/v1/traffic", {}, result => {
          if (!result || typeof result !== "object") {
            reject(new Error("Surge returned an invalid traffic response"));
            return;
          }
          if (result.error) {
            reject(new Error(String(result.error)));
            return;
          }
          if (!result.interface || typeof result.interface !== "object") {
            reject(new Error("Interface traffic data is missing"));
            return;
          }
          resolve(result.interface);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function createSnapshot(interfaces) {
    return {
      wifi: selectWifi(interfaces),
      cellular: aggregateMatching(interfaces, /^pdp_ip\d+$/)
    };
  }

  function selectWifi(interfaces) {
    if (isMetricObject(interfaces.en0)) return normalize(interfaces.en0);

    const fallback = Object.keys(interfaces)
      .filter(key => /^en\d+$/.test(key) && isMetricObject(interfaces[key]))
      .sort()[0];

    return fallback ? normalize(interfaces[fallback]) : null;
  }

  function aggregateMatching(interfaces, pattern) {
    const matches = Object.keys(interfaces)
      .filter(key => pattern.test(key) && isMetricObject(interfaces[key]))
      .map(key => normalize(interfaces[key]));

    if (!matches.length) return null;

    return matches.reduce((total, item) => {
      METRICS.forEach(metric => {
        total[metric] += item[metric];
      });
      return total;
    }, emptyMetrics());
  }

  function isMetricObject(value) {
    return Boolean(value && typeof value === "object");
  }

  function emptyMetrics() {
    return METRICS.reduce((result, metric) => {
      result[metric] = 0;
      return result;
    }, {});
  }

  function normalize(value) {
    return METRICS.reduce((result, metric) => {
      result[metric] = safeNumber(value[metric]);
      return result;
    }, {});
  }

  function createState(day, snapshot, captureSpeed) {
    const state = {
      version: 1,
      day,
      seen: { wifi: false, cellular: false },
      last: { wifi: null, cellular: null },
      traffic: { wifi: emptyPair(), cellular: emptyPair() },
      max: { wifi: emptyPair(), cellular: emptyPair() }
    };

    SECTION_KEYS.forEach(key => {
      const item = snapshot[key];
      if (!item) return;
      state.seen[key] = true;
      state.last[key] = counterPair(item);
      if (captureSpeed) captureMaximum(state.max[key], item);
    });

    return state;
  }

  function updateState(existingState, day, snapshot) {
    if (!isValidState(existingState) || existingState.day !== day) {
      return createState(day, snapshot, true);
    }

    SECTION_KEYS.forEach(key => {
      const item = snapshot[key];
      if (!item) return;

      const current = counterPair(item);
      const previous = existingState.last[key];
      existingState.seen[key] = true;

      if (previous) {
        existingState.traffic[key].out += counterDelta(current.out, previous.out);
        existingState.traffic[key].in += counterDelta(current.in, previous.in);
      }

      existingState.last[key] = current;
      captureMaximum(existingState.max[key], item);
    });

    return existingState;
  }

  function counterDelta(current, previous) {
    return current >= previous ? current - previous : current;
  }

  function captureMaximum(maximum, item) {
    maximum.out = Math.max(maximum.out, item.outCurrentSpeed);
    maximum.in = Math.max(maximum.in, item.inCurrentSpeed);
  }

  function counterPair(item) {
    return { out: item.out, in: item.in };
  }

  function emptyPair() {
    return { out: 0, in: 0 };
  }

  function loadState() {
    const stored = $persistentStore.read(STORE_KEY);
    if (!stored) return null;

    try {
      return JSON.parse(stored);
    } catch (_) {
      return null;
    }
  }

  function saveState(state) {
    const saved = $persistentStore.write(JSON.stringify(state), STORE_KEY);
    if (saved === false) throw new Error("Unable to save daily statistics");
  }

  function isValidState(state) {
    if (!state || state.version !== 1 || typeof state.day !== "string") return false;
    if (!state.seen || !state.last || !state.traffic || !state.max) return false;

    return SECTION_KEYS.every(key => {
      const last = state.last[key];
      return typeof state.seen[key] === "boolean" &&
        (last === null || isPair(last)) &&
        isPair(state.traffic[key]) &&
        isPair(state.max[key]);
    });
  }

  function isPair(value) {
    return Boolean(value &&
      Number.isFinite(value.out) && value.out >= 0 &&
      Number.isFinite(value.in) && value.in >= 0);
  }

  function formatSection(name, key, state) {
    if (!state.seen[key]) return `${name}\nUnavailable`;

    const traffic = state.traffic[key];
    const maximum = state.max[key];

    if (options.style === "normal") {
      return [
        name,
        `Uploaded: ${formatBytes(traffic.out)}`,
        `Downloaded: ${formatBytes(traffic.in)}`,
        `Max Upload Speed: ${formatBytes(maximum.out)}/s`,
        `Max Download Speed: ${formatBytes(maximum.in)}/s`
      ].join("\n");
    }

    return [
      name,
      `Traffic: Up ${formatBytes(traffic.out)} | Down ${formatBytes(traffic.in)}`,
      `Max Speed: Up ${formatBytes(maximum.out)}/s | Down ${formatBytes(maximum.in)}/s`
    ].join("\n");
  }

  function formatBytes(value) {
    const number = safeNumber(value);
    if (number <= 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const index = Math.min(
      Math.floor(Math.log(number) / Math.log(1024)),
      units.length - 1
    );
    const scaled = number / Math.pow(1024, index);
    const precision = index === 0 ? 0 : 2;

    return `${Number(scaled.toFixed(precision))} ${units[index]}`;
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function messageFor(error) {
    return error && error.message ? error.message : String(error || "Unknown error");
  }
})();
