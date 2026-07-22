let body = $response.body || "";
const marker = "/* MPay mCard sales section */";

if (body && !body.includes(marker)) {
  body +=
    `\n${marker}\n` +
    '[data-home-guide-target="product-feed"],.product-feed{display:none!important}';
}

$done({ body });
