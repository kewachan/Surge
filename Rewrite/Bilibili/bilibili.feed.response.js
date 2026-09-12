'use strict';

const body = typeof $response?.body === 'string' ? $response.body : '';

function decode(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === last && (first === '"' || first === "'"))
    ? value.slice(1, -1)
    : value;
}

function parseArguments(value) {
  const result = Object.create(null);
  if (typeof value !== 'string') return result;

  for (const part of value.split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const key = decode(separator === -1 ? part : part.slice(0, separator));
    const rawValue = separator === -1 ? '' : part.slice(separator + 1);
    if (key) result[key] = unquote(decode(rawValue).trim());
  }
  return result;
}

function readBoolean(argumentsMap, key, fallback) {
  const value = argumentsMap[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readUidSet(argumentsMap, key) {
  const value = argumentsMap[key];
  if (!value) return new Set();
  return new Set(String(value).split(',').map(item => item.trim()).filter(Boolean));
}

function isBanner(item) {
  return ['banner_v8', 'banner_ipad_v8'].includes(item?.card_type)
    && item?.card_goto === 'banner';
}

function isAdCard(item) {
  const cardType = item?.card_type;
  const cardGoto = item?.card_goto;

  if (['cm_v1', 'cm_v2'].includes(cardType)
    && ['ad_web_s', 'ad_av', 'ad_web_gif', 'ad_player', 'ad_inline_3d', 'ad_inline_eggs', 'ad_inline_live'].includes(cardGoto)) {
    return true;
  }
  if (cardType === 'cm_double_v9' && cardGoto === 'ad_inline_av') return true;
  if (cardType === 'large_cover_v9' && cardGoto === 'inline_av_v2') return true;
  return cardType === 'small_cover_v10' && cardGoto === 'game';
}

function filterItems(items, settings) {
  return items.filter(item => {
    if (isBanner(item)) {
      if (settings.removeActivity) return false;
      if (Array.isArray(item.banner_item)) {
        item.banner_item = item.banner_item.filter(entry => entry?.type !== 'ad');
      }
      return true;
    }

    if (isAdCard(item)) return false;
    if (settings.removeVertical && item?.goto === 'vertical_av') return false;

    const upId = item?.args?.up_id;
    if (item?.card_type === 'small_cover_v9'
      && item?.card_goto === 'live'
      && upId !== undefined
      && settings.blockedLiveUids.has(String(upId))) {
      return false;
    }
    return true;
  });
}

try {
  const argumentsMap = parseArguments(typeof $argument === 'string' ? $argument : '');
  const settings = {
    removeAds: readBoolean(argumentsMap, 'Feed.AD', true),
    removeActivity: readBoolean(argumentsMap, 'Feed.Activity', true),
    removeVertical: readBoolean(argumentsMap, 'Feed.Vertical', false),
    blockedLiveUids: readUidSet(argumentsMap, 'Feed.BlockUpLiveList')
  };
  const payload = JSON.parse(body);

  if (settings.removeAds && Array.isArray(payload?.data?.items)) {
    payload.data.items = filterItems(payload.data.items, settings);
    $done({ body: JSON.stringify(payload) });
  } else {
    $done({});
  }
} catch {
  $done({});
}
