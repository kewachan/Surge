let body = $response.body || "";
const url = $request.url || "";

const isMcardPage =
  /^https?:\/\/h5\.macaupass\.com\/mcard\/index\.html(?:\?.*)?$/i.test(url);

if (body && isMcardPage && !body.includes('id="mpay-adblock-style"')) {
  const style =
    '<style id="mpay-adblock-style">[data-home-guide-target="product-feed"],.product-feed{display:none!important}</style>';

  body = /<\/head>/i.test(body)
    ? body.replace(/<\/head>/i, `${style}</head>`)
    : `${style}${body}`;
}

if (body && /^https?:\/\/u-api\.mpass\.club\//i.test(url)) {
  try {
    const response = JSON.parse(body);
    const value = response && response.value;

    if (/\/operate\/assets\/listAssets(?:\?.*)?$/i.test(url)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (Array.isArray(value.BANNER)) value.BANNER = [];
        if (Array.isArray(value.VERTICAL_BANNER)) value.VERTICAL_BANNER = [];
      }
    } else if (/\/user\/api\/homePage\/itemShowWindowList(?:\?.*)?$/i.test(url)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        delete value.GOODS_SHOW_WINDOW;
        delete value.SECKILL_SHOW_WINDOW;
      }
    } else if (
      /\/api\/user\/activity\/getNewcomerCouponCampaign(?:\?.*)?$/i.test(url)
    ) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        value.campaignId = "";
        value.needImg = false;
        value.imageUrl = "";
      }
    } else if (/\/frontEnd\/publicConfig(?:\?.*)?$/i.test(url)) {
      const isEncoded = typeof value === "string";
      const config = isEncoded ? JSON.parse(value) : value;

      if (config && typeof config === "object" && !Array.isArray(config)) {
        delete config.payDoneBanner;
        response.value = isEncoded ? JSON.stringify(config) : config;
      }
    }

    body = JSON.stringify(response);
  } catch (_) {
    // Keep malformed or unexpected responses unchanged.
  }
}

$done({ body });
