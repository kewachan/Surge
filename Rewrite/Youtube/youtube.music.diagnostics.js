// Run manually in Surge. Reads only bounded, non-secret playback diagnostics.
(function () {
  const fields = ["at", "scriptBuild", "result", "candidateCount", "configBuild", "configAgeSeconds", "workerStatus", "workerResult"];
  function safe(record) {
    if (!record || typeof record !== "object") return null;
    const output = {};
    for (const name of fields) {
      const value = record[name];
      if (typeof value === "number" && Number.isFinite(value)) output[name] = value;
      else if (typeof value === "string" && /^(?:\d{8}-\d+|unknown|missing-key|transform-timeout|transform-error|invalid-transform|invalid-structure|unsupported-response|bypass-error|removed-\d+)$/.test(value)) output[name] = value;
    }
    return output;
  }
  try {
    const raw = $persistentStore.read("YouTubeMusic.Diagnostics.v1");
    const state = raw && raw.length < 12000 ? JSON.parse(raw) : {};
    console.log(JSON.stringify({readerBuild: "20261104-2",
      failures: (Array.isArray(state?.failures) ? state.failures : []).slice(-8).map(safe).filter(Boolean),
      lastSuccess: safe(state?.lastSuccess)}, null, 2));
  } catch (_) {
    console.log("YouTube Music: no readable diagnostic record.");
  } finally { $done({}); }
})();
