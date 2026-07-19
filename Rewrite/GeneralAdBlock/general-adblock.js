/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

let body = $response.body || "";

// Google Search: hide the "Ask and explore anything with the Google app" promo.
if ($request.url.includes("www.google.com/search")) {
  if (body.includes("Ask and explore anything with the Google app")) {
    body = body
      .replaceAll(
        'class=\\"B2VR9 CJHX3e\\"',
        'class=\\"B2VR9 CJHX3e\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="B2VR9 CJHX3e"',
        'class="B2VR9 CJHX3e" style="display:none!important"'
      );
  }
}

$done({ body });
