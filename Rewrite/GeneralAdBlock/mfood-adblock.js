/**
 * Remove mFood launch-screen advertisements.
 *
 * The endpoint returns base64-encoded zlib data rather than plain JSON.
 * This is the compressed representation of an empty JSON array, allowing
 * the app to receive a valid response and replace any cached splash list.
 */

const EMPTY_COMPRESSED_LIST = "eJyLjgUAARUAuQ==";

$done({ body: EMPTY_COMPRESSED_LIST });
