/**
 * Google AdBlock for Surge
 *
 * Directly hides ad containers in Google Search HTML responses.
 */

let body = $response.body || "";
const isGoogleSearch = /https?:\/\/(www\.)?google\.[^/]+\/search/i.test($request.url);
const hiddenStyle = 'style="display:none!important"';

function addHiddenStyle(tag) {
  if (/style=(['"])[^'"]*display\s*:\s*none/i.test(tag)) {
    return tag;
  }

  if (/style=(['"])/i.test(tag)) {
    return tag.replace(/style=(['"])([^'"]*)\1/i, function(_, quote, style) {
      return "style=" + quote + "display:none!important;" + style + quote;
    });
  }

  return tag.replace(/>$/, " " + hiddenStyle + ">");
}

function isSponsoredTag(tag) {
  return /\bid=(['"])(?:tvcap|tads|tadsb)\1/i.test(tag) ||
    /\bjscontroller=(['"])tY2w9d\1/i.test(tag) ||
    /\bjsname=(['"])ix0Hvc\1/i.test(tag) ||
    /\bdata-text-ad=(['"])1\1/i.test(tag) ||
    /\bclass=(['"])[^'"]*\b(?:qGXjvb|vbIt3d|IuoSj)\b[^'"]*\1/i.test(tag);
}

if (isGoogleSearch) {
  // Known working response replacement for the Google app promotion.
  if (body.includes("Ask and explore anything with the Google app")) {
    body = body
      .replaceAll(
        'class=\\"B2VR9 CJHX3e\\"',
        'class=\\"B2VR9 CJHX3e\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="B2VR9 CJHX3e"',
        'class="B2VR9 CJHX3e" style="display:none!important"'
      )
      .replaceAll(
        'class=\\"CJHX3e B2VR9\\"',
        'class=\\"CJHX3e B2VR9\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="CJHX3e B2VR9"',
        'class="CJHX3e B2VR9" style="display:none!important"'
      );
  }

  // The HAR places Sponsored Result in these server-rendered ad containers.
  // Editing the response works even when Google's CSP blocks injected scripts.
  if (/Sponsored result|\bid=(['"])(?:tvcap|tads|tadsb)\1/i.test(body)) {
    body = body.replace(/<[a-z][^>]*>/gi, function(tag) {
      return isSponsoredTag(tag) ? addHiddenStyle(tag) : tag;
    });
  }
}

$done({ body: body });
