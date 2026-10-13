#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_PREFIX = "# Source: ";
const MITM_AUDIT_PREFIX = "# MITM audit: ";
const DEFAULT_MAX_CHANGE_RATIO = 0.2;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SOURCE_BYTES = 1_500_000;
const ALLOWED_SOURCE_HOSTS = new Set([
  "raw.githubusercontent.com",
  "ruleset.skk.moe",
  "yfamilys.com",
]);
const SUPPORTED_REWRITE_ACTIONS = new Set(["reject", "302", "header"]);
const DENIED_URL_REWRITES = new Set([
  '"^https?:\\/\\/acs\\.m\\.taobao\\.com\\/gw\\/mtop\\.damai\\.mec\\.popup\\.get" - reject',
  "^https?:\\/\\/(www|s)\\.youtube\\.com\\/api\\/stats\\/ads - reject",
  "^https?:\\/\\/(www|s)\\.youtube\\.com\\/(pagead|ptracking) - reject",
  "^https?:\\/\\/\\s.youtube.com/api/stats/qoe?.*adformat= - reject",
  "^https?:\\/\\/s\\.youtube\\.com\\/api\\/stats\\/qoe(?:\\?.*)?$ - reject",
]);
const DENIED_MITM_HOSTS = new Set(["s.youtube.com"]);

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = path.resolve(SCRIPT_DIRECTORY, "../../Rewrite/Advertising.sgmodule");
const DEFAULT_STATE = path.resolve(SCRIPT_DIRECTORY, "advertising-source-state.json");

function normalizeText(text) {
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueInOrder(values) {
  return [...new Set(values)];
}

function validateSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid source URL: ${value}`);
  }

  if (url.protocol !== "https:" || !ALLOWED_SOURCE_HOSTS.has(url.hostname)) {
    throw new Error(`Source URL is not an approved HTTPS host: ${value}`);
  }

  return url.href;
}

function findSection(text, sectionName, label) {
  const lines = normalizeText(text).split("\n");
  const indexes = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === sectionName) indexes.push(index);
  }

  if (indexes.length !== 1) {
    throw new Error(`${label}: expected exactly one ${sectionName}, found ${indexes.length}`);
  }

  const start = indexes[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^\[[^\]]+\]$/u.test(lines[index].trim())) {
      end = index;
      break;
    }
  }

  return { end, lines, start };
}

export function parseUrlRewriteSection(text, label = "module") {
  const section = findSection(text, "[URL Rewrite]", label);
  const rules = [];

  for (let index = section.start; index < section.end; index += 1) {
    const line = section.lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (line.includes("\u0000") || line.length > 16_384) {
      throw new Error(`${label}:${index + 1}: invalid URL Rewrite line`);
    }

    const action = line.split(/\s+/u).at(-1)?.toLowerCase();
    if (!SUPPORTED_REWRITE_ACTIONS.has(action)) {
      throw new Error(`${label}:${index + 1}: unsupported URL Rewrite action: ${action}`);
    }
    rules.push(line);
  }

  if (rules.length === 0) throw new Error(`${label}: [URL Rewrite] contains no rules`);
  return uniqueInOrder(rules);
}

export function parseMitmHosts(text, label = "module") {
  const section = findSection(text, "[MITM]", label);
  const hosts = [];
  let hostnameLines = 0;

  for (let index = section.start; index < section.end; index += 1) {
    const line = section.lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (/^hostname-disabled\s*=/iu.test(line)) continue;
    if (!/^hostname\s*=/iu.test(line)) {
      throw new Error(`${label}:${index + 1}: unsupported [MITM] entry`);
    }

    hostnameLines += 1;
    const value = line
      .replace(/^hostname\s*=\s*/iu, "")
      .replace(/^%APPEND%\s*/u, "");
    for (const host of value.split(",").map((item) => item.trim())) {
      if (!host) continue;
      if (host.length > 255 || !/^[A-Za-z0-9.*?_\[\]:-]+$/u.test(host)) {
        throw new Error(`${label}:${index + 1}: invalid MITM hostname: ${host}`);
      }
      hosts.push(host);
    }
  }

  if (hostnameLines === 0 || hosts.length === 0) {
    throw new Error(`${label}: [MITM] contains no hostname entries`);
  }
  return uniqueInOrder(hosts);
}

export function parseSourceDefinitions(text) {
  const definitions = [];
  const seen = new Set();

  for (const rawLine of normalizeText(text).split("\n")) {
    const line = rawLine.trim();
    let role;
    let value;
    if (line.startsWith(SOURCE_PREFIX)) {
      role = "source";
      value = line.slice(SOURCE_PREFIX.length).trim();
    } else if (line.startsWith(MITM_AUDIT_PREFIX)) {
      role = "mitm-audit";
      value = line.slice(MITM_AUDIT_PREFIX.length).trim();
    } else {
      continue;
    }

    const url = validateSourceUrl(value);
    if (seen.has(url)) throw new Error(`Duplicate source URL: ${url}`);
    seen.add(url);
    definitions.push({ role, url });
  }

  if (definitions.length === 0) {
    throw new Error(`Advertising module must contain ${SOURCE_PREFIX.trim()} comments`);
  }
  return definitions;
}

export function parseTargetModule(text) {
  const normalized = normalizeText(text);
  const urlSection = findSection(normalized, "[URL Rewrite]", "target module");
  const mitmSection = findSection(normalized, "[MITM]", "target module");
  if (urlSection.start >= mitmSection.start) {
    throw new Error("target module: [URL Rewrite] must appear before [MITM]");
  }

  const activeSections = normalized.match(/^\[[^\]]+\]$/gmu) || [];
  if (activeSections.length !== 2) {
    throw new Error("target module: only [URL Rewrite] and [MITM] are supported");
  }

  return {
    mitmHosts: parseMitmHosts(normalized, "target module"),
    preamble: urlSection.lines.slice(0, urlSection.start - 1).join("\n").trimEnd(),
    sourceDefinitions: parseSourceDefinitions(normalized),
    urlRewrite: parseUrlRewriteSection(normalized, "target module"),
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareAscii);
}

function sourceIdentity(definitions) {
  return definitions.map(({ role, url }) => ({ role, url }));
}

export function buildSnapshot(sourceResults) {
  const urlRewrite = [];
  const mitmHosts = [];
  const sources = [];

  for (const result of sourceResults) {
    const rules = result.role === "source" ? result.urlRewrite : [];
    urlRewrite.push(...rules);
    mitmHosts.push(...result.mitmHosts);
    sources.push({
      mitmHostCount: result.mitmHosts.length,
      role: result.role,
      url: result.url,
      urlRewriteCount: rules.length,
    });
  }

  return {
    mitmHosts: sortedUnique(mitmHosts),
    schemaVersion: 1,
    sources,
    urlRewrite: sortedUnique(urlRewrite),
  };
}

function validateSnapshot(value, definitions, label) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.sources)) {
    throw new Error(`${label}: unsupported or malformed state file`);
  }
  if (!Array.isArray(value.urlRewrite) || !Array.isArray(value.mitmHosts)) {
    throw new Error(`${label}: missing tracked arrays`);
  }
  if (!value.urlRewrite.every((line) => typeof line === "string")) {
    throw new Error(`${label}: invalid URL Rewrite state`);
  }
  if (!value.mitmHosts.every((host) => typeof host === "string")) {
    throw new Error(`${label}: invalid MITM state`);
  }

  const expected = JSON.stringify(sourceIdentity(definitions));
  const actual = JSON.stringify(
    value.sources.map(({ role, url }) => ({ role, url })),
  );
  if (expected !== actual) {
    throw new Error(`${label}: source definitions do not match the module header`);
  }

  return {
    ...value,
    mitmHosts: sortedUnique(value.mitmHosts),
    urlRewrite: sortedUnique(value.urlRewrite),
  };
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

export function applyUpstreamDelta(currentValues, previousValues, nextValues, denied = new Set()) {
  const nextSet = new Set(nextValues);
  const additions = setDifference(nextValues, previousValues).filter((value) => !denied.has(value));
  const removals = new Set(setDifference(previousValues, nextValues));
  const proposed = currentValues.filter((value) => !removals.has(value) || nextSet.has(value));
  const present = new Set(proposed);

  for (const value of additions.sort(compareAscii)) {
    if (!present.has(value)) {
      present.add(value);
      proposed.push(value);
    }
  }

  return uniqueInOrder(proposed);
}

export function calculateChange(existingValues, proposedValues) {
  const existing = new Set(existingValues);
  const proposed = new Set(proposedValues);
  let added = 0;
  let removed = 0;
  for (const value of proposed) if (!existing.has(value)) added += 1;
  for (const value of existing) if (!proposed.has(value)) removed += 1;
  return {
    added,
    ratio: (added + removed) / Math.max(existing.size, 1),
    removed,
  };
}

export function renderTargetModule({ mitmHosts, preamble, urlRewrite }) {
  return (
    `${preamble}\n\n[URL Rewrite]\n` +
    `${urlRewrite.join("\n")}\n\n[MITM]\n` +
    `hostname = %APPEND% ${mitmHosts.join(",")}\n`
  );
}

function renderState(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function fetchSource(definition) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(definition.url, {
      headers: {
        Accept: "text/plain, application/octet-stream;q=0.9, */*;q=0.1",
        "User-Agent": "Mozilla/5.0 kewachan-surge-module-updater/1.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${definition.url}: HTTP ${response.status}`);
    validateSourceUrl(response.url);

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_SOURCE_BYTES) {
      throw new Error(`${definition.url}: source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
      throw new Error(`${definition.url}: source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    if (normalizeText(text).trimStart().startsWith("<")) {
      throw new Error(`${definition.url}: source returned HTML instead of a Surge module`);
    }

    const mitmHosts = parseMitmHosts(text, definition.url);
    const urlRewrite =
      definition.role === "source" ? parseUrlRewriteSection(text, definition.url) : [];
    return { ...definition, mitmHosts, urlRewrite };
  } finally {
    clearTimeout(timeout);
  }
}

function parseArguments(argv) {
  const options = {
    allowLargeChange: false,
    bootstrap: false,
    check: false,
    dryRun: false,
    maxChangeRatio: Number(
      process.env.MAX_ADVERTISING_MODULE_CHANGE_RATIO || DEFAULT_MAX_CHANGE_RATIO,
    ),
    statePath: DEFAULT_STATE,
    targetPath: DEFAULT_TARGET,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-large-change") options.allowLargeChange = true;
    else if (argument === "--bootstrap") options.bootstrap = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--file") {
      index += 1;
      if (!argv[index]) throw new Error("--file requires a path");
      options.targetPath = path.resolve(argv[index]);
    } else if (argument === "--state-file") {
      index += 1;
      if (!argv[index]) throw new Error("--state-file requires a path");
      options.statePath = path.resolve(argv[index]);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.maxChangeRatio) || options.maxChangeRatio < 0) {
    throw new Error("MAX_ADVERTISING_MODULE_CHANGE_RATIO must be a non-negative number");
  }
  if (options.bootstrap && (options.check || options.dryRun)) {
    throw new Error("--bootstrap cannot be combined with --check or --dry-run");
  }
  return options;
}

async function atomicWrite(targetPath, content) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function formatChange(label, change) {
  return `${label}: ${change.added} added, ${change.removed} removed`;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const currentContent = await readFile(options.targetPath, "utf8");
  const target = parseTargetModule(currentContent);
  const sourceResults = await Promise.all(target.sourceDefinitions.map(fetchSource));
  const nextSnapshot = buildSnapshot(sourceResults);

  if (options.bootstrap) {
    try {
      await readFile(options.statePath, "utf8");
      throw new Error(`State file already exists: ${options.statePath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await atomicWrite(options.statePath, renderState(nextSnapshot));
    console.log(
      `Bootstrapped ${nextSnapshot.urlRewrite.length} URL rewrites and ` +
        `${nextSnapshot.mitmHosts.length} MITM hosts without changing the target module.`,
    );
    return;
  }

  const stateText = await readFile(options.statePath, "utf8");
  let previousSnapshot;
  try {
    previousSnapshot = validateSnapshot(
      JSON.parse(stateText),
      target.sourceDefinitions,
      options.statePath,
    );
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${options.statePath}: invalid JSON`);
    throw error;
  }

  const proposedRules = applyUpstreamDelta(
    target.urlRewrite,
    previousSnapshot.urlRewrite,
    nextSnapshot.urlRewrite,
    DENIED_URL_REWRITES,
  );
  const proposedHosts = applyUpstreamDelta(
    target.mitmHosts,
    previousSnapshot.mitmHosts,
    nextSnapshot.mitmHosts,
    DENIED_MITM_HOSTS,
  );
  const proposedContent = renderTargetModule({
    mitmHosts: proposedHosts,
    preamble: target.preamble,
    urlRewrite: proposedRules,
  });
  const proposedState = renderState(nextSnapshot);

  const targetChange = calculateChange(
    [...target.urlRewrite, ...target.mitmHosts.map((host) => `MITM:${host}`)],
    [...proposedRules, ...proposedHosts.map((host) => `MITM:${host}`)],
  );
  const sourceChange = calculateChange(
    [...previousSnapshot.urlRewrite, ...previousSnapshot.mitmHosts.map((host) => `MITM:${host}`)],
    [...nextSnapshot.urlRewrite, ...nextSnapshot.mitmHosts.map((host) => `MITM:${host}`)],
  );

  for (const [label, change] of [
    ["Target churn", targetChange],
    ["Upstream churn", sourceChange],
  ]) {
    if (change.ratio > options.maxChangeRatio && !options.allowLargeChange) {
      throw new Error(
        `${label} ${(change.ratio * 100).toFixed(1)}% exceeds ` +
          `${(options.maxChangeRatio * 100).toFixed(1)}% ` +
          `(${change.added} added, ${change.removed} removed). ` +
          "Review upstream changes and rerun manually with --allow-large-change if safe.",
      );
    }
  }

  const targetChanged = proposedContent !== normalizeText(currentContent);
  const stateChanged = proposedState !== normalizeText(stateText);
  const summary =
    `${targetChanged || stateChanged ? "Update available" : "Already current"}. ` +
    `${formatChange("target", targetChange)}; ${formatChange("upstream", sourceChange)}.`;

  if (options.check) {
    if (targetChanged || stateChanged) {
      console.error(summary);
      process.exitCode = 1;
    } else {
      console.log(summary);
    }
    return;
  }
  if (options.dryRun || (!targetChanged && !stateChanged)) {
    console.log(summary);
    return;
  }

  if (targetChanged) await atomicWrite(options.targetPath, proposedContent);
  await atomicWrite(options.statePath, proposedState);
  console.log(summary);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
