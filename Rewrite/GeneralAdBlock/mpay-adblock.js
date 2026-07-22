let body = $response.body || "";
const url = $request.url || "";

if (
  body &&
  /^https?:\/\/h5\.macaupass\.com\/mcard\/index\.html(?:\?.*)?$/i.test(url) &&
  !body.includes('id="mpay-adblock-style"')
) {
  const style =
    '<style id="mpay-adblock-style">[data-home-guide-target="product-feed"],.product-feed{display:none!important}</style>';

  body = /<\/head>/i.test(body)
    ? body.replace(/<\/head>/i, `${style}</head>`)
    : `${style}${body}`;
}

$done({ body });
