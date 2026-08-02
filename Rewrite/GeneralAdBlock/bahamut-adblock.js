/**
 * Bahamut Anime ad bypass for Surge.
 *
 * Bahamut validates the ad viewing interval server-side. Hide the ad payload,
 * wait for the legacy validation window, report completion, then retry the
 * playback-source request. Supports both the legacy m3u8.php endpoint and the
 * current video_src.php endpoint used by the iOS app.
 */

const AD_WAIT_MS = 25000;
const requestURL = $request.url || "";
let responseJSON;

try {
  responseJSON = JSON.parse($response.body || "{}");
} catch (error) {
  console.log(`[BahamutAnimeAds] Invalid JSON response: ${error.message || error}`);
  $done({});
}

if (responseJSON) {
  run()
    .then(() => $done({ body: JSON.stringify(responseJSON) }))
    .catch((error) => {
      console.log(`[BahamutAnimeAds] ${error.message || error}`);
      $done({});
    });
}

async function run() {
  if (requestURL.includes("/token.php")) {
    clearAdSlots(responseJSON);
    return;
  }

  if (!isPlaybackSource(requestURL) || !hasPlaybackError(responseJSON)) {
    return;
  }

  const videoSn = getVideoSn(requestURL);
  if (!videoSn) {
    throw new Error("Missing video serial number");
  }

  await reportAdProgress("", videoSn);
  await sleep(AD_WAIT_MS);
  await reportAdProgress("end", videoSn);

  const retriedResponse = await fetchJSON(requestURL, $request.headers || {});
  if (retriedResponse) {
    responseJSON = retriedResponse;
  }
}

function clearAdSlots(body) {
  if (body.ad) {
    body.ad.minor = [];
    body.ad.major = [];
  }

  if (body.data && body.data.ad) {
    body.data.ad.minor = [];
    body.data.ad.major = [];
  }
}

function isPlaybackSource(url) {
  return url.includes("/m3u8.php") || url.includes("/video_src.php");
}

function hasPlaybackError(body) {
  return Boolean(body && (body.error || body.message));
}

function getVideoSn(url) {
  const match = url.match(/[?&](?:videoSn|sn)=(\d+)/i);
  return match ? match[1] : "";
}

function reportAdProgress(stage, videoSn) {
  const url =
    "https://api.gamer.com.tw/mobile_app/anime/v1/stat_ad.php" +
    `?ad=${encodeURIComponent(stage)}&schedule=0&sn=${encodeURIComponent(videoSn)}`;

  return fetchText(url, $request.headers || {}).then(() => undefined);
}

function fetchJSON(url, headers) {
  return fetchText(url, headers).then((body) => {
    try {
      return JSON.parse(body || "{}");
    } catch (error) {
      throw new Error(`Invalid retry response: ${error.message || error}`);
    }
  });
}

function fetchText(url, headers) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, headers }, (error, response, body) => {
      if (error) {
        reject(new Error(String(error)));
        return;
      }

      resolve(body || "");
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
