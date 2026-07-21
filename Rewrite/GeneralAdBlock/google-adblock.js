/**
 * Google AdBlock for Surge
 *
 * Directly hides ad containers in Google Search HTML responses.
 */

let body = $response.body || "";
const isGoogleSearch = /https?:\/\/(www\.)?google\.[^/]+\/search/i.test($request.url);
const isPaginationResponse = /[?&](?:asearch=arc|async=arc_id(?::|%3A))/i.test($request.url);
const sponsoredStyle = 'style="display:none!important"';

function addSponsoredStyle(tag) {
  if (/style=(['"])[^'"]*display\s*:\s*none/i.test(tag)) {
    return tag;
  }

  if (/style=(['"])/i.test(tag)) {
    return tag.replace(/style=(['"])([^'"]*)\1/i, function(_, quote, style) {
      return "style=" + quote + "display:none!important;" + style + quote;
    });
  }

  return tag.replace(/>$/, " " + sponsoredStyle + ">");
}

function isSponsoredTag(tag) {
  return /\bid=(['"])tads\1/i.test(tag) ||
    /\bjscontroller=(['"])tY2w9d\1/i.test(tag) ||
    /\bjsname=(['"])ix0Hvc\1/i.test(tag) ||
    /\bdata-text-ad=(['"])1\1/i.test(tag);
}

if (isGoogleSearch && !isPaginationResponse) {
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

  // Hide the complete Sponsored Result header and content without leaving gaps.
  // ARC pagination responses are excluded above and in the module pattern.
  if (/Sponsored result|\bid=(['"])tads\1/i.test(body)) {
    body = body.replace(/<[a-z][^>]*>/gi, function(tag) {
      return isSponsoredTag(tag) ? addSponsoredStyle(tag) : tag;
    });
  }
  $done({ body: body });
} else {
  // Preserve Google's ARC pagination protocol and response framing.
  $done({});
}
