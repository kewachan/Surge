/**
 * Google AdBlock for Surge
 *
 * Directly hides ad containers in Google Search HTML responses.
 */

const originalBody = $response.body || "";
let body = originalBody;
const isGoogleSearch = /https?:\/\/(www\.)?google\.[^/]+\/search/i.test($request.url);
const isPaginationResponse = /[?&](?:asearch=arc|async=arc_id(?::|%3A))/i.test($request.url);
const sponsoredStyle = 'style="display:none!important"';

function getResponseStatusCode() {
  const rawStatus = $response.statusCode || $response.status || "";
  const match = String(rawStatus).match(/\b(\d{3})\b/);

  // Keep compatibility with engines that do not expose the response status.
  return match ? parseInt(match[1], 10) : 200;
}

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

function getElementInnerHtmlById(html, id) {
  const openingTag = new RegExp(
    "<([a-z][\\w:-]*)\\b[^>]*\\bid=(['\"])" + id + "\\2[^>]*>",
    "i"
  ).exec(html);
  if (!openingTag) {
    return null;
  }

  const tagName = openingTag[1];
  const contentStart = openingTag.index + openingTag[0].length;
  const tagPattern = new RegExp("<\\/?" + tagName + "\\b[^>]*>", "gi");
  tagPattern.lastIndex = contentStart;
  let depth = 1;
  let match;

  while ((match = tagPattern.exec(html)) !== null) {
    if (/^<\//.test(match[0])) {
      depth -= 1;
    } else if (!/\/>$/.test(match[0])) {
      depth += 1;
    }

    if (depth === 0) {
      return html.slice(contentStart, match.index);
    }
  }

  return null;
}

function hasMeaningfulSponsoredContainer(html) {
  for (const id of ["tads", "tadsb"]) {
    const innerHtml = getElementInnerHtmlById(html, id);
    if (innerHtml === null) {
      continue;
    }

    if (/<(?:a|button|iframe|img|picture|svg|video)\b/i.test(innerHtml)) {
      return true;
    }

    const visibleText = innerHtml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&(?:nbsp|#160|#xA0);/gi, "")
      .trim();
    if (visibleText) {
      return true;
    }
  }

  return false;
}

function isSponsoredTag(tag) {
  return /\bid=(['"])tadsb?\1/i.test(tag) ||
    /\bjscontroller=(['"])tY2w9d\1/i.test(tag) ||
    /\bjsname=(['"])ix0Hvc\1/i.test(tag) ||
    /\bdata-text-ad=(['"])1\1/i.test(tag);
}

function hideSponsoredHtml(html) {
  const hasSponsoredContent = /\bdata-text-ad=(['"])1\1/i.test(html) ||
    /\bjscontroller=(['"])tY2w9d\1/i.test(html) ||
    /\bjsname=(['"])ix0Hvc\1/i.test(html) ||
    /(?:\/|\\x2f)(?:pagead(?:\/|\\x2f))?aclk(?:\?|\\x3f)/i.test(html) ||
    hasMeaningfulSponsoredContainer(html);
  if (!hasSponsoredContent) {
    return html;
  }

  return html.replace(/<[a-z][^>]*>/gi, function(tag) {
    return isSponsoredTag(tag) ? addSponsoredStyle(tag) : tag;
  });
}

function rewriteArcResponse(text) {
  const prefix = text.startsWith(")]}'\n") ? ")]}'\n" : "";
  let position = prefix.length;
  let output = prefix;

  while (position < text.length) {
    const header = text.slice(position).match(/^([0-9a-f]+);/i);
    if (!header) {
      return null;
    }

    const length = parseInt(header[1], 16);
    const start = position + header[0].length;
    const end = start + length;
    if (end > text.length) {
      return null;
    }

    const payload = hideSponsoredHtml(text.slice(start, end));
    output += payload.length.toString(16) + ";" + payload;
    position = end;
  }

  return output;
}

const responseStatusCode = getResponseStatusCode();
const canRewriteResponse = isGoogleSearch && responseStatusCode === 200;

if (canRewriteResponse && isPaginationResponse) {
  const rewritten = rewriteArcResponse(body);
  if (rewritten !== null && rewritten !== body) {
    $done({ body: rewritten });
  } else {
    $done({});
  }
} else if (canRewriteResponse) {
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
  body = hideSponsoredHtml(body);
  if (body !== originalBody) {
    $done({ body: body });
  } else {
    // Preserve the original response and all duplicate Set-Cookie fields when
    // there is nothing to rewrite. This also avoids touching redirects/challenges.
    $done({});
  }
} else {
  $done({});
}
