/**
 * General AdBlock for Surge
 *
 * Response modifications that cannot be handled safely by rules or URL Rewrite.
 */

let body = $response.body || "";

// Google Search: hide the "Ask and explore anything with the Google app" promo.
if ($request.url.includes("www.google.com/search")) {
  const style =
    '<style id="general-adblock-google-promo">' +
    '.B2VR9.CJHX3e:has(a[href*="iga.google.com"]){display:none!important}' +
    '</style>';

  if (!body.includes("general-adblock-google-promo")) {
    body = body.replace(/<\/head>/i, `${style}</head>`);
  }
}

$done({ body });
