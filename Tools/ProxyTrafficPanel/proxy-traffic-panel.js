/**
 * Proxy Daily Traffic for Surge — v1.0.1
 * Samples per-policy engine counters and displays local-calendar-day totals.
 */

(function () {
  "use strict";

  const STORE_KEY = "proxy_daily_traffic_state_v1";
  const PANEL_TITLE = "Proxy Daily Traffic";
  const BUILT_INS = new Set([
    "DIRECT", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF",
    "PROXY", "GLOBAL", "FINAL", "CELLULAR", "CELLULAR-ONLY", "HYBRID", "NO-HYBRID"
  ]);
  const GROUP_TYPES = new Set([
    "select", "url-test", "fallback", "load-balance", "subnet", "ssid", "smart"
  ]);
  const NON_PROXY_TYPES = new Set([
    "direct", "reject", "reject-drop", "reject-no-drop", "reject-tinygif"
  ]);

  const options = parseArguments(typeof $argument === "string" ? $argument : "");
  const panelRun = isPanelRun();
  let completed = false;

  function finish(value) {
    if (completed) return;
    completed = true;
    $done(value);
  }

  function isPanelRun() {
    if (typeof $input === "object" && $input && $input.purpose === "panel") return true;
    return typeof $script === "object" && $script && $script.type === "generic";
  }

  function parseArguments(raw) {
    const values = {};
    String(raw).split("&").forEach(part => {
      const index = part.indexOf("=");
      if (index < 1) return;
      const key = part.slice(0, index).trim();
      let value = part.slice(index + 1).trim();
      try { value = decodeURIComponent(value); } catch (_) {}
      values[key] = value;
    });
    const port = Number(values.api_port || 6171);
    const apiKey = String(values.api_key || "").trim();
    return {
      apiKey: apiKey.toLowerCase() === "none" ? "" : apiKey,
      apiPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 6171
    };
  }

  function api(method, path, body, callback) {
    try {
      $httpAPI(method, path, body || {}, result => {
        if (result && typeof result === "object" && result.error) {
          callback(new Error(String(result.error)));
          return;
        }
        callback(null, result);
      });
    } catch (error) {
      callback(error);
    }
  }

  function extractMetricsText(value, depth) {
    if (typeof value === "string") {
      return value.includes("surge_policy_") ? value : "";
    }
    if (!value || typeof value !== "object" || depth > 4) return "";
    for (const key of ["text", "content", "body", "data", "result", "metrics"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const found = extractMetricsText(value[key], depth + 1);
      if (found) return found;
    }
    return "";
  }

  function requestExternalMetrics(callback) {
    if (!options.apiKey) {
      callback(new Error("Metrics unavailable. Set the local HTTP API key in module settings."));
      return;
    }
    if (typeof $httpClient !== "object" || typeof $httpClient.get !== "function") {
      callback(new Error("HTTP client is unavailable for the metrics fallback."));
      return;
    }
    try {
      $httpClient.get({
        url: `http://127.0.0.1:${options.apiPort}/v1/metrics`,
        headers: { "X-Key": options.apiKey, Accept: "text/plain" },
        policy: "DIRECT",
        timeout: 8,
        "auto-redirect": false
      }, (error, response, data) => {
        const status = Number(response && (response.status || response.statusCode));
        if (error || status !== 200 || typeof data !== "string") {
          callback(new Error("Unable to read per-policy metrics from the local HTTP API."));
          return;
        }
        callback(null, data);
      });
    } catch (error) {
      callback(error);
    }
  }

  function requestMetrics(callback) {
    try {
      $httpAPI("GET", "v1/metrics", {}, result => {
        const text = extractMetricsText(result, 0);
        if (text) {
          callback(null, text);
        } else {
          requestExternalMetrics(callback);
        }
      });
    } catch (_) {
      requestExternalMetrics(callback);
    }
  }

  function unescapePrometheus(value) {
    let output = "";
    for (let index = 0; index < value.length; index++) {
      const character = value[index];
      if (character !== "\\" || index + 1 >= value.length) {
        output += character;
        continue;
      }
      const escaped = value[++index];
      output += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
    }
    return output;
  }

  function policyLabel(labels) {
    const match = String(labels).match(/(?:^|,)\s*policy="((?:\\.|[^"\\])*)"/);
    return match ? unescapePrometheus(match[1]) : "";
  }

  function parseMetrics(text) {
    const counters = Object.create(null);
    let uptime = null;

    String(text).replace(/\r\n?/g, "\n").split("\n").forEach(rawLine => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) return;

      const uptimeMatch = line.match(/^surge_uptime_seconds\s+(\S+)/);
      if (uptimeMatch) {
        const value = Number(uptimeMatch[1]);
        if (Number.isFinite(value) && value >= 0) uptime = value;
        return;
      }

      const match = line.match(/^surge_policy_(in|out)_bytes_total\{([^}]*)\}\s+(\S+)/);
      if (!match) return;
      const name = policyLabel(match[2]);
      const value = Number(match[3]);
      if (!name || !Number.isFinite(value) || value < 0) return;
      if (!counters[name]) counters[name] = { download: 0, upload: 0 };
      counters[name][match[1] === "in" ? "download" : "upload"] = value;
    });

    if (!Object.keys(counters).length) {
      throw new Error("No per-policy traffic counters were returned by Surge.");
    }
    return { counters, uptime };
  }

  function dayKey(timestamp) {
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function localMidnight(timestamp) {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function readState() {
    try {
      const raw = $persistentStore.read(STORE_KEY);
      const state = raw ? JSON.parse(raw) : null;
      return state && state.version === 1 ? state : null;
    } catch (_) {
      return null;
    }
  }

  function pair(value) {
    return {
      download: Number(value && value.download) || 0,
      upload: Number(value && value.upload) || 0
    };
  }

  function copyTotals(source) {
    const output = Object.create(null);
    Object.keys(source || {}).forEach(name => { output[name] = pair(source[name]); });
    return output;
  }

  function counterDelta(current, previous, reset) {
    const now = pair(current);
    const before = pair(previous);
    return {
      download: reset || now.download < before.download ? now.download : now.download - before.download,
      upload: reset || now.upload < before.upload ? now.upload : now.upload - before.upload
    };
  }

  function addTraffic(totals, name, amount, fraction) {
    if (!totals[name]) totals[name] = { download: 0, upload: 0 };
    totals[name].download += amount.download * fraction;
    totals[name].upload += amount.upload * fraction;
  }

  function engineStartedToday(metrics, now, midnight) {
    return Number.isFinite(metrics.uptime) && now - metrics.uptime * 1000 >= midnight;
  }

  function updateDailyState(metrics) {
    const now = Date.now();
    const today = dayKey(now);
    const midnight = localMidnight(now);
    const previous = readState();
    const sameDay = previous && previous.date === today;
    const previousCounters = previous && previous.lastCounters ? previous.lastCounters : {};
    const previousUptime = Number(previous && previous.lastUptime);
    const engineReset = previous && Number.isFinite(metrics.uptime) && Number.isFinite(previousUptime)
      ? metrics.uptime < previousUptime
      : false;
    const totals = sameDay ? copyTotals(previous.totals) : Object.create(null);
    const currentNames = Object.keys(metrics.counters);

    currentNames.forEach(name => {
      const current = pair(metrics.counters[name]);
      const hadPreviousCounter = Object.prototype.hasOwnProperty.call(previousCounters, name);

      if (!previous) {
        if (engineStartedToday(metrics, now, midnight)) addTraffic(totals, name, current, 1);
        return;
      }

      if (sameDay) {
        if (hadPreviousCounter) {
          addTraffic(totals, name, counterDelta(current, previousCounters[name], engineReset), 1);
        } else if (engineStartedToday(metrics, now, midnight)) {
          addTraffic(totals, name, current, 1);
        }
        return;
      }

      const engineStart = Number.isFinite(metrics.uptime) ? now - metrics.uptime * 1000 : NaN;
      if (Number.isFinite(engineStart) && engineStart >= midnight) {
        addTraffic(totals, name, current, 1);
        return;
      }

      if (!hadPreviousCounter || !Number.isFinite(Number(previous.updatedAt))) return;
      const delta = counterDelta(current, previousCounters[name], engineReset);
      const intervalStart = engineReset && Number.isFinite(engineStart)
        ? engineStart
        : Number(previous.updatedAt);
      const elapsed = now - intervalStart;
      const todayElapsed = now - Math.max(intervalStart, midnight);
      const fraction = elapsed > 0 ? Math.max(0, Math.min(1, todayElapsed / elapsed)) : 0;
      addTraffic(totals, name, delta, fraction);
    });

    Object.keys(totals).forEach(name => {
      totals[name].download = Math.max(0, Math.round(totals[name].download));
      totals[name].upload = Math.max(0, Math.round(totals[name].upload));
    });

    const state = {
      version: 1,
      date: today,
      totals,
      lastCounters: metrics.counters,
      lastUptime: metrics.uptime,
      updatedAt: now
    };
    if (!$persistentStore.write(JSON.stringify(state), STORE_KEY)) {
      throw new Error("Unable to save daily traffic state.");
    }
    return state;
  }

  function extractProfileText(result) {
    if (typeof result === "string") return result;
    if (!result || typeof result !== "object") return "";
    for (const key of ["profile", "content", "text", "profile_text", "profileText"]) {
      if (typeof result[key] === "string") return result[key];
    }
    return result.data && result.data !== result ? extractProfileText(result.data) : "";
  }

  function parseProfilePolicies(text) {
    const names = [];
    let section = "";
    String(text).replace(/\r\n?/g, "\n").split("\n").forEach(rawLine => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) return;
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) {
        section = header[1].trim().toLowerCase();
        return;
      }
      if (section !== "proxy") return;
      const equal = line.indexOf("=");
      if (equal < 1) return;
      const name = line.slice(0, equal).trim();
      const type = line.slice(equal + 1).split(",", 1)[0].trim().toLowerCase();
      if (name && type && !NON_PROXY_TYPES.has(type)) names.push(name);
    });
    return uniqueNames(names);
  }

  function itemName(item) {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    return String(item.name || item.policy_name || item.policyName || item.policy || "").trim();
  }

  function itemType(item) {
    if (!item || typeof item !== "object") return "";
    return String(item.type || item.kind || item.group_type || item.groupType || "").toLowerCase();
  }

  function namesFromContainer(container, rejectGroups) {
    if (Array.isArray(container)) {
      return container.map(item => {
        const type = itemType(item);
        if (rejectGroups && (GROUP_TYPES.has(type) || NON_PROXY_TYPES.has(type))) return "";
        return itemName(item);
      }).filter(Boolean);
    }
    if (!container || typeof container !== "object") return [];
    return Object.keys(container).filter(key => {
      const value = container[key];
      if (["error", "message", "status", "time", "winner"].includes(key)) return false;
      const type = itemType(value);
      if (rejectGroups && (GROUP_TYPES.has(type) || NON_PROXY_TYPES.has(type))) return false;
      return value !== null && value !== undefined;
    });
  }

  function extractPolicyNames(result) {
    if (Array.isArray(result)) return namesFromContainer(result, true);
    if (!result || typeof result !== "object") return [];
    const containers = [
      result.proxies, result["proxy-policies"], result.proxy_policies,
      result.policies, result.policy_names, result.policyNames, result.items
    ];
    if (result.data && result.data !== result) {
      containers.push(
        result.data.proxies, result.data["proxy-policies"], result.data.proxy_policies,
        result.data.policies, result.data.items, result.data
      );
    }
    for (const container of containers) {
      const names = namesFromContainer(container, true);
      if (names.length) return names;
    }
    return [];
  }

  function extractGroupNames(result) {
    if (Array.isArray(result)) return namesFromContainer(result, false);
    if (!result || typeof result !== "object") return [];
    const containers = [
      result["policy-groups"], result.policy_groups, result.policyGroups,
      result.groups, result.items
    ];
    if (result.data && result.data !== result) {
      containers.push(
        result.data["policy-groups"], result.data.policy_groups,
        result.data.policyGroups, result.data.groups, result.data.items
      );
    }
    for (const container of containers) {
      const names = namesFromContainer(container, false);
      if (names.length) return names;
    }
    return [];
  }

  function uniqueNames(names) {
    const seen = new Set();
    return names.filter(name => {
      const normalized = String(name || "").trim();
      if (!normalized || BUILT_INS.has(normalized.toUpperCase()) || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  function metricPolicyNames(metrics) {
    return uniqueNames(Object.keys(metrics.counters));
  }

  function discoverPolicies(metrics, callback) {
    api("GET", "v1/profiles/current", { sensitive: 0 }, (profileError, profileResult) => {
      const profileNames = profileError ? [] : parseProfilePolicies(extractProfileText(profileResult));
      api("GET", "v1/policies", {}, (policyError, policyResult) => {
        if (policyError) {
          callback(uniqueNames(profileNames.concat(metricPolicyNames(metrics))));
          return;
        }
        api("GET", "v1/policy_groups", {}, (_groupError, groupResult) => {
          const groups = new Set(extractGroupNames(groupResult));
          const liveNames = extractPolicyNames(policyResult).filter(name => !groups.has(name));
          const discovered = uniqueNames(profileNames.concat(liveNames));
          callback(discovered.length ? discovered : metricPolicyNames(metrics));
        });
      });
    });
  }

  function formatBytes(value) {
    const amount = Math.max(0, Number(value) || 0);
    const units = ["B", "KB", "MB", "GB", "TB"];
    let scaled = amount;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024;
      unit++;
    }
    const digits = unit === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${scaled.toFixed(digits)} ${units[unit]}`;
  }

  function panelResult(policies, state) {
    const totals = state.totals || {};
    const rows = policies.map(name => {
      const traffic = pair(totals[name]);
      return {
        name,
        download: traffic.download,
        upload: traffic.upload,
        total: traffic.download + traffic.upload
      };
    }).sort((left, right) => right.total - left.total || left.name.localeCompare(right.name));
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const content = rows.length
      ? [`Total: ${formatBytes(total)}`].concat(rows.flatMap(row => [
        row.name,
        `↓ ${formatBytes(row.download)}  ↑ ${formatBytes(row.upload)}  Σ ${formatBytes(row.total)}`
      ])).join("\n")
      : "No custom proxy policies found";
    return { title: PANEL_TITLE, content, style: "info" };
  }

  function fail(error) {
    const message = error && error.message ? error.message : String(error || "Unknown error");
    console.log(`Proxy traffic sample failed: ${message}`);
    if (panelRun) {
      finish({ title: PANEL_TITLE, content: message, style: "error" });
    } else {
      finish();
    }
  }

  requestMetrics((metricsError, text) => {
    if (metricsError) {
      fail(metricsError);
      return;
    }

    let metrics;
    let state;
    try {
      metrics = parseMetrics(text);
      state = updateDailyState(metrics);
    } catch (error) {
      fail(error);
      return;
    }

    discoverPolicies(metrics, policies => {
      if (panelRun) {
        finish(panelResult(policies, state));
      } else {
        const total = Object.keys(state.totals || {}).reduce((sum, name) => {
          const traffic = pair(state.totals[name]);
          return sum + traffic.download + traffic.upload;
        }, 0);
        console.log(`Sampled ${policies.length} custom proxies; today ${formatBytes(total)}`);
        finish();
      }
    });
  });
})();
