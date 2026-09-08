/**
 * Node Offline Monitor for Surge — v1.4.1
 * Discovers custom proxy policies from the active profile and notifies once
 * when a node goes offline or resumes.
 */

(function () {
  "use strict";

  const STORE_KEY = "node_offline_monitor_state_v1";
  const FALLBACK_TEST_URL = "http://www.gstatic.com/generate_204";
  const PROBE_CONCURRENCY = 16;
  const PROBE_TIMEOUT = 8;
  const CONFIRMATION_DELAY_MS = 5000;
  const REQUIRED_FAILURES = 3;
  const BUILT_INS = new Set([
    "DIRECT", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF",
    "PROXY", "GLOBAL", "FINAL"
  ]);
  const GROUP_TYPES = new Set([
    "select", "url-test", "fallback", "load-balance", "subnet", "ssid", "smart"
  ]);
  const NON_PROXY_TYPES = new Set([
    "direct", "reject", "reject-drop", "reject-no-drop", "reject-tinygif"
  ]);

  const options = parseArguments(typeof $argument === "string" ? $argument : "");
  let completed = false;
  let unsupportedResultLogged = false;
  let directFallbackUsed = false;

  function finish() {
    if (!completed) {
      completed = true;
      $done();
    }
  }

  function parseArguments(raw) {
    const values = {};
    raw.split("&").forEach(part => {
      const index = part.indexOf("=");
      if (index < 1) return;
      const key = part.slice(0, index).trim();
      let value = part.slice(index + 1).trim();
      try { value = decodeURIComponent(value); } catch (_) {}
      values[key] = value;
    });
    return {
      testUrl: values.test_url || "auto"
    };
  }

  function api(method, path, body, callback) {
    try {
      $httpAPI(method, path, body || {}, result => {
        if (result && result.error) {
          callback(new Error(String(result.error)));
          return;
        }
        callback(null, result);
      });
    } catch (error) {
      callback(error);
    }
  }

  function extractProfileText(result) {
    if (typeof result === "string") return result;
    if (!result || typeof result !== "object") return "";
    const keys = ["profile", "content", "text", "profile_text", "profileText"];
    for (const key of keys) {
      if (typeof result[key] === "string") return result[key];
    }
    if (result.data && result.data !== result) return extractProfileText(result.data);
    return "";
  }

  function parseProfile(text) {
    const policies = [];
    let testUrl = "";
    let section = "";

    String(text).replace(/\r\n?/g, "\n").split("\n").forEach(rawLine => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) return;
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) {
        section = header[1].trim().toLowerCase();
        return;
      }
      const equal = line.indexOf("=");
      if (equal < 1) return;

      const name = line.slice(0, equal).trim();
      const value = line.slice(equal + 1).trim();
      if (section === "general" && name.toLowerCase() === "proxy-test-url") {
        testUrl = value;
        return;
      }
      if (section !== "proxy") return;

      const type = value.split(",", 1)[0].trim().toLowerCase();
      if (name && type && !NON_PROXY_TYPES.has(type)) policies.push(name);
    });

    return { policies: uniqueNames(policies), testUrl };
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
        if (rejectGroups && (GROUP_TYPES.has(itemType(item)) || NON_PROXY_TYPES.has(itemType(item)))) return "";
        return itemName(item);
      }).filter(Boolean);
    }
    if (!container || typeof container !== "object") return [];
    return Object.keys(container).filter(key => {
      const value = container[key];
      if (["error", "message", "status", "time", "winner"].includes(key)) return false;
      if (rejectGroups && GROUP_TYPES.has(itemType(value))) return false;
      return value !== null && value !== undefined;
    });
  }

  function extractPolicyNames(result) {
    if (Array.isArray(result)) return namesFromContainer(result, true);
    if (!result || typeof result !== "object") return [];
    const containers = [
      result.proxies,
      result["proxy-policies"],
      result.proxy_policies,
      result.policies,
      result.policy_names,
      result.policyNames,
      result.items
    ];
    if (result.data && result.data !== result) {
      containers.push(
        result.data.proxies,
        result.data["proxy-policies"],
        result.data.proxy_policies,
        result.data.policies,
        result.data.items,
        result.data
      );
    }
    for (const container of containers) {
      const names = namesFromContainer(container, true);
      if (names.length) return names;
    }
    const structuralKeys = [
      "proxies", "proxy-policies", "proxy_policies", "policies",
      "policy-groups", "policy_groups", "policyGroups", "groups", "items", "data"
    ];
    if (structuralKeys.some(key => Object.prototype.hasOwnProperty.call(result, key))) return [];
    return namesFromContainer(result, true);
  }

  function extractGroupNames(result) {
    if (Array.isArray(result)) return namesFromContainer(result, false);
    if (!result || typeof result !== "object") return [];
    const containers = [
      result["policy-groups"],
      result.policy_groups,
      result.policyGroups,
      result.groups,
      result.items
    ];
    if (result.data && result.data !== result) {
      containers.push(
        result.data["policy-groups"],
        result.data.policy_groups,
        result.data.policyGroups,
        result.data.groups,
        result.data.items
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
      if (!name || BUILT_INS.has(name.toUpperCase()) || seen.has(name)) return false;
      seen.add(name);
      return true;
    }).sort((a, b) => a.localeCompare(b));
  }

  function discoverPolicies(profileResult, callback) {
    const profileText = extractProfileText(profileResult);
    const parsed = parseProfile(profileText);
    api("GET", "v1/policies", {}, (policyError, policyResult) => {
      if (policyError) {
        if (parsed.policies.length) {
          callback(null, parsed.policies, parsed.testUrl);
        } else {
          callback(policyError);
        }
        return;
      }
      api("GET", "v1/policy_groups", {}, (_groupError, groupResult) => {
        const groups = new Set(extractGroupNames(groupResult));
        const livePolicies = extractPolicyNames(policyResult).filter(name => !groups.has(name));
        const policies = uniqueNames(parsed.policies.concat(livePolicies));
        if (!policies.length) {
          callback(new Error("No testable custom proxy policies were found in the current profile"));
          return;
        }
        callback(null, policies, parsed.testUrl);
      });
    });
  }

  function explicitAvailable(result, depth) {
    if (!result || typeof result !== "object" || depth > 5) return null;
    for (const key of ["available", "availablePolicyNames", "available_policy_names"]) {
      if (Array.isArray(result[key])) return result[key].map(itemName).filter(Boolean);
    }
    for (const key of ["result", "results", "data"]) {
      const value = result[key];
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          const found = explicitAvailable(value[index], depth + 1);
          if (found) return found;
        }
      } else {
        const found = explicitAvailable(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function findStatusMap(result, policies, depth) {
    if (!result || typeof result !== "object" || depth > 6) return null;
    if (Array.isArray(result)) {
      for (let index = result.length - 1; index >= 0; index--) {
        const found = findStatusMap(result[index], policies, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (policies.some(name => Object.prototype.hasOwnProperty.call(result, name))) return result;
    for (const key of ["data", "result", "results", "policies"]) {
      const found = findStatusMap(result[key], policies, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function findNamedStatusMap(result, policies, depth) {
    if (!result || typeof result !== "object" || depth > 6) return null;
    if (Array.isArray(result)) {
      const map = {};
      result.forEach(item => {
        const name = itemName(item);
        if (name && policies.includes(name)) map[name] = item;
      });
      if (Object.keys(map).length) return map;
      for (let index = result.length - 1; index >= 0; index--) {
        const found = findNamedStatusMap(result[index], policies, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const key of ["data", "result", "results", "policies", "items"]) {
      const found = findNamedStatusMap(result[key], policies, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function statusIsAvailable(status) {
    if (typeof status === "boolean") return status;
    if (typeof status === "number") return Number.isFinite(status) && status > 0;
    if (typeof status === "string") {
      const normalized = status.trim().toLowerCase();
      if (/^(ok|online|available|success|true)$/.test(normalized)) return true;
      const number = Number(normalized);
      return Number.isFinite(number) && number > 0;
    }
    if (!status || typeof status !== "object") return false;
    if (Object.keys(status).length === 0 || status.error) return false;
    if (Object.prototype.hasOwnProperty.call(status, "available")) {
      return statusIsAvailable(status.available);
    }
    if (typeof status.status === "string") return statusIsAvailable(status.status);
    return ["latency", "rtt", "tcp", "receive", "delay"].some(key =>
      typeof status[key] === "number" && status[key] > 0
    );
  }

  function availabilityFromResult(result, policies) {
    const listed = explicitAvailable(result, 0);
    if (listed) return new Set(listed.filter(name => policies.includes(name)));
    const statusMap = findStatusMap(result, policies, 0) ||
      findNamedStatusMap(result, policies, 0);
    if (!statusMap) return null;
    return new Set(policies.filter(name => statusIsAvailable(statusMap[name])));
  }

  function resultShape(value, depth) {
    if (value === null) return "null";
    if (Array.isArray(value)) {
      if (depth >= 2 || value.length === 0) return `array(${value.length})`;
      return `array(${value.length})<${resultShape(value[0], depth + 1)}>`;
    }
    if (typeof value !== "object") return typeof value;
    const keys = Object.keys(value).slice(0, 20);
    if (depth >= 1) return `object(${Object.keys(value).length} keys)`;
    return `{${keys.map(key => `${key}:${resultShape(value[key], depth + 1)}`).join(",")}}`;
  }

  function probePolicies(policies, url, callback) {
    if (typeof $httpClient !== "object" || typeof $httpClient.head !== "function") {
      callback(new Error("Direct policy probing is unavailable"));
      return;
    }

    const available = new Set();
    const permissionErrors = [];
    let cursor = 0;
    let active = 0;
    let settled = 0;
    let finished = false;

    function completeIfReady() {
      if (finished || settled !== policies.length) return false;
      finished = true;
      if (permissionErrors.length === policies.length) {
        callback(new Error("Surge rejected direct policy probing; check the http-client-policy ability"));
      } else {
        callback(null, available);
      }
      return true;
    }

    function settle(policy, error, response) {
      active--;
      settled++;
      const status = Number(response && response.status);
      if (!error && Number.isFinite(status) && status > 0) {
        available.add(policy);
      } else if (/ability|permission|not allowed|not permitted/i.test(String(error || ""))) {
        permissionErrors.push(policy);
      }
      if (!completeIfReady()) pump();
    }

    function pump() {
      while (!finished && active < PROBE_CONCURRENCY && cursor < policies.length) {
        const policy = policies[cursor++];
        active++;
        try {
          $httpClient.head({
            url,
            policy,
            timeout: PROBE_TIMEOUT,
            "auto-redirect": true
          }, (error, response) => settle(policy, error, response));
        } catch (error) {
          settle(policy, error, null);
        }
      }
    }

    if (!policies.length) {
      callback(null, available);
      return;
    }
    pump();
  }

  function testPolicySet(policies, url, callback) {
    api("POST", "v1/policies/test", { policy_names: policies, url }, (testError, result) => {
      if (testError) {
        callback(testError);
        return;
      }
      const available = availabilityFromResult(result, policies);
      if (available) {
        callback(null, available);
        return;
      }
      if (!unsupportedResultLogged) {
        unsupportedResultLogged = true;
        log(`Unsupported policy test response; using direct probes. Shape: ${resultShape(result, 0)}`);
      }
      directFallbackUsed = true;
      probePolicies(policies, url, callback);
    });
  }

  function confirmOffline(policies, url, callback) {
    let candidates = policies.slice();
    let attempt = 1;

    function complete() {
      if (directFallbackUsed) log("Direct policy probe fallback completed");
      callback(null, candidates);
    }

    function runAttempt() {
      testPolicySet(candidates, url, (error, available) => {
        if (error) {
          callback(error);
          return;
        }
        candidates = candidates.filter(name => !available.has(name));
        log(`Offline confirmation ${attempt}/${REQUIRED_FAILURES}: ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`);
        if (!candidates.length || attempt === REQUIRED_FAILURES) {
          complete();
          return;
        }
        attempt++;
        setTimeout(runAttempt, CONFIRMATION_DELAY_MS);
      });
    }

    runAttempt();
  }

  function readState() {
    try {
      const value = $persistentStore.read(STORE_KEY);
      const state = value ? JSON.parse(value) : null;
      return state && state.version === 1 ? state : null;
    } catch (_) {
      return null;
    }
  }

  function formatNames(names) {
    const shown = names.slice(0, 20);
    const extra = names.length - shown.length;
    return shown.map(name => `• ${name}`).join("\n") + (extra > 0 ? `\n…and ${extra} more` : "");
  }

  function nodeCount(count) {
    return `${count} node${count === 1 ? "" : "s"}`;
  }

  function notify(title, subtitle, body) {
    $notification.post(title, subtitle, body, { sound: true, "auto-dismiss": false });
  }

  function log(message) {
    console.log(message);
    if (typeof $surge === "object" && typeof $surge.logbook === "function") {
      $surge.logbook(message);
    }
  }

  function saveResult(policies, offline) {
    const previous = readState();
    const previousOffline = new Set(previous && Array.isArray(previous.offline) ? previous.offline : []);
    const currentPolicies = new Set(policies);
    const currentOffline = new Set(offline);
    const newlyOffline = offline.filter(name => !previousOffline.has(name));
    const resumed = Array.from(previousOffline).filter(name =>
      currentPolicies.has(name) && !currentOffline.has(name)
    );
    const manual = typeof $trigger !== "undefined";

    if (!previous) {
      if (offline.length) {
        notify("Proxy Nodes Offline", "", formatNames(offline));
      }
    } else {
      if (newlyOffline.length) {
        notify("Proxy Nodes Offline", "", formatNames(newlyOffline));
      }
      if (resumed.length) {
        notify("Proxy Nodes Resumed", "", formatNames(resumed));
      }
      if (manual && offline.length && !newlyOffline.length) {
        notify("Proxy Nodes Offline", "", formatNames(offline));
      }
    }

    $persistentStore.write(JSON.stringify({
      version: 1,
      policies,
      offline,
      checkedAt: Date.now(),
      lastError: ""
    }), STORE_KEY);
    log(`Tested ${nodeCount(policies.length)} from the current profile; ${offline.length} offline`);
  }

  function reportError(error) {
    const message = error && error.message ? error.message : String(error || "Unknown error");
    const previous = readState();
    if (!previous || previous.lastError !== message || typeof $trigger !== "undefined") {
      notify("Proxy Node Monitor Failed", "Previous state was preserved", message);
    }
    const state = previous || { version: 1, policies: [], offline: [], checkedAt: 0 };
    state.lastError = message;
    $persistentStore.write(JSON.stringify(state), STORE_KEY);
    log(`Monitor failed: ${message}`);
    finish();
  }

  api("GET", "v1/profiles/current", { sensitive: 0 }, (profileError, profileResult) => {
    if (profileError) {
      reportError(profileError);
      return;
    }
    discoverPolicies(profileResult, (discoveryError, policies, profileTestUrl) => {
      if (discoveryError) {
        reportError(discoveryError);
        return;
      }
      const testUrl = options.testUrl === "auto"
        ? (profileTestUrl || FALLBACK_TEST_URL)
        : options.testUrl;
      confirmOffline(policies, testUrl, (testError, offline) => {
        if (testError) {
          reportError(testError);
          return;
        }
        saveResult(policies, offline);
        finish();
      });
    });
  });
})();
