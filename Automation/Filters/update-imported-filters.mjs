#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "# Imported List";
const SOURCE_PREFIX = "# Source: ";
const FILTER_DATE_PATTERN = /^# Last Updated:\s*.*$/mu;
const DEFAULT_MAX_CHANGE_RATIO = 0.2;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 2_000_000;
const ALLOWED_SOURCE_HOSTS = new Set(["raw.githubusercontent.com"]);
const TYPE_ORDER = new Map(
  ["DOMAIN", "DOMAIN-KEYWORD", "DOMAIN-SUFFIX", "IP-CIDR", "IP-CIDR6"].map(
    (type, index) => [type, index],
  ),
);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = path.resolve(SCRIPT_DIRECTORY, "../../Filters/filters_block.list");
const DEFAULT_STATE = path.resolve(SCRIPT_DIRECTORY, "block-list-source-state.json");

function normalizeText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function formatMacauDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Macau",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function setFilterUpdatedDate(text, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error(`Invalid filter update date: ${date}`);
  }

  const normalized = normalizeText(text);
  const dateLine = `# Last Updated: ${date}`;
  if (FILTER_DATE_PATTERN.test(normalized)) {
    return normalized.replace(FILTER_DATE_PATTERN, dateLine);
  }

  const lines = normalized.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === "#AI Generated");
  if (headerIndex === -1) throw new Error("Block list is missing the #AI Generated header");
  lines.splice(headerIndex + 1, 0, dateLine);
  return lines.join("\n");
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

function validateRuleValue(type, value, location) {
  if (!value || /[\s,#]/u.test(value)) {
    throw new Error(`${location}: invalid ${type} value: ${value || "<empty>"}`);
  }

  if (type === "IP-CIDR" || type === "IP-CIDR6") {
    const match = value.match(/^(.+)\/(\d{1,3})$/u);
    if (!match) {
      throw new Error(`${location}: invalid CIDR value: ${value}`);
    }

    const family = isIP(match[1]);
    const prefix = Number(match[2]);
    const expectedFamily = type === "IP-CIDR" ? 4 : 6;
    const maxPrefix = expectedFamily === 4 ? 32 : 128;
    if (family !== expectedFamily || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`${location}: invalid ${type} value: ${value}`);
    }
  }
}

export function parseRuleLine(line, location = "rule") {
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 2) {
    throw new Error(`${location}: malformed rule: ${line}`);
  }

  const type = parts[0].toUpperCase();
  if (!TYPE_ORDER.has(type)) {
    throw new Error(`${location}: unsupported rule type: ${parts[0]}`);
  }

  const value = parts[1].toLowerCase();
  validateRuleValue(type, value, location);

  return {
    key: `${type}\u0000${value}`,
    line: `${type}, ${value}`,
    type,
    value,
  };
}

export function parseRuleText(text, label = "source") {
  const rules = new Map();
  const lines = normalizeText(text).split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const rule = parseRuleLine(line, `${label}:${index + 1}`);
    rules.set(rule.key, rule);
  }

  if (rules.size === 0) {
    throw new Error(`${label}: source contains no supported rules`);
  }

  return [...rules.values()];
}

function collectManualRuleKeys(lines) {
  const keys = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || !line.includes(",")) continue;

    const type = line.slice(0, line.indexOf(",")).trim().toUpperCase();
    if (!TYPE_ORDER.has(type)) continue;

    const rule = parseRuleLine(line, `manual list:${index + 1}`);
    keys.add(rule.key);
  }

  return keys;
}

export function parseTargetFile(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const markerIndexes = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === MARKER) markerIndexes.push(index);
  }

  if (markerIndexes.length !== 1) {
    throw new Error(`Expected exactly one ${MARKER} marker, found ${markerIndexes.length}`);
  }

  const markerIndex = markerIndexes[0];
  const manualLines = lines.slice(0, markerIndex);
  const sourceUrls = [];
  let cursor = markerIndex + 1;

  while (cursor < lines.length) {
    const line = lines[cursor].trim();
    if (!line) {
      cursor += 1;
      continue;
    }
    if (!line.startsWith(SOURCE_PREFIX)) break;

    sourceUrls.push(validateSourceUrl(line.slice(SOURCE_PREFIX.length).trim()));
    cursor += 1;
  }

  if (sourceUrls.length === 0) {
    throw new Error(`${MARKER} must be followed by at least one ${SOURCE_PREFIX.trim()} line`);
  }

  const existingText = lines.slice(cursor).join("\n");
  const existingRules = parseRuleText(existingText, "current imported list");

  return {
    existingRules,
    manualRuleKeys: collectManualRuleKeys(manualLines),
    manualText: manualLines.join("\n").trimEnd(),
    sourceUrls,
  };
}

export function mergeImportedRules(ruleGroups, manualRuleKeys = new Set()) {
  const merged = new Map();

  for (const group of ruleGroups) {
    for (const rule of group) {
      if (!manualRuleKeys.has(rule.key)) merged.set(rule.key, rule);
    }
  }

  return [...merged.values()].sort((left, right) => {
    const typeDifference = TYPE_ORDER.get(left.type) - TYPE_ORDER.get(right.type);
    return typeDifference || compareAscii(left.value, right.value);
  });
}

function sortedRules(rules) {
  return mergeImportedRules([rules]);
}

export function buildSnapshot(sourceResults) {
  return {
    rules: sortedRules(sourceResults.flatMap(({ rules }) => rules)).map((rule) => rule.line),
    schemaVersion: 1,
    sources: sourceResults.map(({ rules, url }) => ({
      ruleCount: rules.length,
      url,
    })),
  };
}

function validateSnapshot(value, sourceUrls, label) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.sources)) {
    throw new Error(`${label}: unsupported or malformed state file`);
  }
  if (!Array.isArray(value.rules) || !value.rules.every((line) => typeof line === "string")) {
    throw new Error(`${label}: invalid tracked rules`);
  }

  const expected = JSON.stringify(sourceUrls);
  const actual = JSON.stringify(value.sources.map(({ url }) => url));
  if (expected !== actual) {
    throw new Error(`${label}: source definitions do not match ${MARKER}`);
  }

  return {
    ...value,
    rules: parseRuleText(value.rules.join("\n"), label),
  };
}

export function applyUpstreamDelta(
  currentRules,
  previousRules,
  nextRules,
  manualRuleKeys = new Set(),
) {
  const previousKeys = new Set(previousRules.map((rule) => rule.key));
  const nextByKey = new Map(nextRules.map((rule) => [rule.key, rule]));
  const removedKeys = new Set(
    previousRules.filter((rule) => !nextByKey.has(rule.key)).map((rule) => rule.key),
  );
  const proposed = currentRules.filter((rule) => !removedKeys.has(rule.key));
  const presentKeys = new Set(proposed.map((rule) => rule.key));

  for (const rule of nextRules) {
    if (
      !previousKeys.has(rule.key) &&
      !presentKeys.has(rule.key) &&
      !manualRuleKeys.has(rule.key)
    ) {
      presentKeys.add(rule.key);
      proposed.push(rule);
    }
  }

  return sortedRules(proposed);
}

export function renderTargetFile({ manualText, sourceUrls, importedRules }) {
  const sourceLines = sourceUrls.map((url) => `${SOURCE_PREFIX}${url}`);
  const ruleLines = importedRules.map((rule) => rule.line);
  return `${manualText}\n\n${MARKER}\n${sourceLines.join("\n")}\n${ruleLines.join("\n")}\n`;
}

export function calculateChange(existingRules, proposedRules) {
  const existing = new Set(existingRules.map((rule) => rule.key));
  const proposed = new Set(proposedRules.map((rule) => rule.key));
  let added = 0;
  let removed = 0;

  for (const key of proposed) if (!existing.has(key)) added += 1;
  for (const key of existing) if (!proposed.has(key)) removed += 1;

  return {
    added,
    ratio: (added + removed) / Math.max(existing.size, 1),
    removed,
  };
}

async function fetchSource(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/plain, application/octet-stream;q=0.9, */*;q=0.1",
        "User-Agent": "kewachan-surge-filter-updater/1.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }

    validateSourceUrl(response.url);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_SOURCE_BYTES) {
      throw new Error(`${url}: source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
      throw new Error(`${url}: source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }

    return parseRuleText(text, url);
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
    maxChangeRatio: Number(process.env.MAX_IMPORTED_FILTER_CHANGE_RATIO || DEFAULT_MAX_CHANGE_RATIO),
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
    throw new Error("MAX_IMPORTED_FILTER_CHANGE_RATIO must be a non-negative number");
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

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const currentContent = await readFile(options.targetPath, "utf8");
  const target = parseTargetFile(currentContent);
  const sourceGroups = await Promise.all(target.sourceUrls.map((url) => fetchSource(url)));
  const nextSnapshot = buildSnapshot(
    target.sourceUrls.map((url, index) => ({ rules: sourceGroups[index], url })),
  );

  if (options.bootstrap) {
    try {
      await readFile(options.statePath, "utf8");
      throw new Error(`State file already exists: ${options.statePath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await atomicWrite(options.statePath, `${JSON.stringify(nextSnapshot, null, 2)}\n`);
    console.log(
      `Bootstrapped ${nextSnapshot.rules.length} upstream rules without changing the block list.`,
    );
    return;
  }

  const stateText = await readFile(options.statePath, "utf8");
  let previousSnapshot;
  try {
    previousSnapshot = validateSnapshot(
      JSON.parse(stateText),
      target.sourceUrls,
      options.statePath,
    );
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${options.statePath}: invalid JSON`);
    throw error;
  }

  const nextRules = parseRuleText(nextSnapshot.rules.join("\n"), "current upstream state");
  const importedRules = applyUpstreamDelta(
    target.existingRules,
    previousSnapshot.rules,
    nextRules,
    target.manualRuleKeys,
  );
  const renderedContent = renderTargetFile({
    importedRules,
    manualText: target.manualText,
    sourceUrls: target.sourceUrls,
  });
  const rulesChanged = renderedContent !== normalizeText(currentContent);
  const proposedContent =
    rulesChanged || !FILTER_DATE_PATTERN.test(normalizeText(currentContent))
      ? setFilterUpdatedDate(renderedContent, formatMacauDate())
      : renderedContent;
  const proposedState = `${JSON.stringify(nextSnapshot, null, 2)}\n`;
  const targetChange = calculateChange(target.existingRules, importedRules);
  const sourceChange = calculateChange(previousSnapshot.rules, nextRules);
  const targetChanged = proposedContent !== normalizeText(currentContent);
  const stateChanged = proposedState !== normalizeText(stateText);

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

  const summary =
    `${targetChanged || stateChanged ? "Update available" : "Already current"}: ` +
    `${importedRules.length} imported rules; target ${targetChange.added} added, ` +
    `${targetChange.removed} removed; upstream ${sourceChange.added} added, ` +
    `${sourceChange.removed} removed.`;

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
