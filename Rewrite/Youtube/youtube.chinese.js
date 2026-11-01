// Shared script-conversion policy; deliberately excludes regional word substitution.
export function chineseTarget(target) {
  const language = String(target || "").toLowerCase();
  if (["zh-hans", "zh-cn", "zh-sg"].includes(language)) return "cn";
  if (["zh", "zh-hant", "zh-tw", "zh-hk", "zh-mo"].includes(language)) return "t";
  return "";
}

export function chineseLyricLine(text) {
  return /\p{Script=Han}/u.test(text) && !/\p{Letter}/u.test(text.replace(/[\p{Script=Han}\p{Script=Latin}]/gu, ""));
}

export function chineseConversionEnabled(target, lines) {
  return Boolean(chineseTarget(target))
    && !lines.some((line) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(line));
}
