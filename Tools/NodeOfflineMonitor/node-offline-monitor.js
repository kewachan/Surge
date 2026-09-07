/**
 * Node Offline Monitor for Surge — v1.1.0
 * Discovers custom proxy policies from the active profile and reports
 * persistent offline states on every scheduled check by default.
 */

(function () {
  "use strict";

  const STORE_KEY = "node_offline_monitor_state_v1";
  const FALLBACK_TEST_URL = "http://www.gstatic.com/generate_204";
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
      testUrl: values.test_url || "auto",
      notifyRecovery: values.notify_recovery !== "false",
      notifyHealthy: values.notify_healthy === "true",
      repeatOffline: values.repeat_offline !== "false"
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
    const containers = [result.policies, result.policy_names, result.policyNames, result.items];
    if (result.data && result.data !== result) containers.push(result.data.policies, result.data.items, result.data);
    for (const container of containers) {
      const names = namesFromContainer(container, true);
      if (names.length) return names;
    }
    return namesFromContainer(result, true);
  }

  function extractGroupNames(result) {
    if (Array.isArray(result)) return namesFromContainer(result, false);
    if (!result || typeof result !== "object") return [];
    const containers = [result.groups, result.policy_groups, result.policyGroups, result.items];
    if (result.data && result.data !== result) containers.push(result.data.groups, result.data.items);
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
          callback(new Error("目前 Profile 找不到可測試的自定義節點"));
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
    return shown.map(name => `• ${name}`).join("\n") + (extra > 0 ? `\n…另有 ${extra} 個` : "");
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
    const recovered = Array.from(previousOffline).filter(name =>
      currentPolicies.has(name) && !currentOffline.has(name)
    );
    const manual = typeof $trigger !== "undefined";

    if (!previous) {
      if (offline.length) {
        notify("節點離線監察", `發現 ${offline.length} 個離線節點`, formatNames(offline));
      } else if (options.notifyHealthy || manual) {
        notify("節點離線監察", "全部節點正常", `已測試 ${policies.length} 個自定義節點`);
      }
    } else if (newlyOffline.length || recovered.length) {
      const sections = [];
      if (newlyOffline.length) sections.push(`新離線：\n${formatNames(newlyOffline)}`);
      if (recovered.length && options.notifyRecovery) sections.push(`已恢復：\n${formatNames(recovered)}`);
      if (sections.length) {
        notify(
          "節點狀態更新",
          `離線 ${offline.length}/${policies.length}`,
          sections.join("\n\n")
        );
      }
    } else if (offline.length && options.repeatOffline) {
      notify(
        "節點離線監察",
        `仍有 ${offline.length} 個離線節點`,
        formatNames(offline)
      );
    } else if (offline.length === 0 && options.notifyHealthy) {
      notify("節點離線監察", "全部節點正常", `已測試 ${policies.length} 個自定義節點`);
    } else if (manual) {
      notify(
        "節點離線監察",
        offline.length ? `仍有 ${offline.length} 個離線節點` : "全部節點正常",
        offline.length ? formatNames(offline) : `已測試 ${policies.length} 個自定義節點`
      );
    }

    $persistentStore.write(JSON.stringify({
      version: 1,
      policies,
      offline,
      checkedAt: Date.now(),
      lastError: ""
    }), STORE_KEY);
    log(`已測試 ${policies.length} 個 Profile 自定義節點；離線 ${offline.length} 個`);
  }

  function reportError(error) {
    const message = error && error.message ? error.message : String(error || "未知錯誤");
    const previous = readState();
    if (!previous || previous.lastError !== message || typeof $trigger !== "undefined") {
      notify("節點離線監察失敗", "未有改動上次狀態", message);
    }
    const state = previous || { version: 1, policies: [], offline: [], checkedAt: 0 };
    state.lastError = message;
    $persistentStore.write(JSON.stringify(state), STORE_KEY);
    log(`監察失敗：${message}`);
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
      api("POST", "v1/policies/test", { policy_names: policies, url: testUrl }, (testError, result) => {
        if (testError) {
          reportError(testError);
          return;
        }
        const available = availabilityFromResult(result, policies);
        if (!available) {
          reportError(new Error("Surge 未回傳可識別的節點測試結果"));
          return;
        }
        saveResult(policies, policies.filter(name => !available.has(name)));
        finish();
      });
    });
  });
})();
