// Hack to work around window.crypto being undefined in Node (e.g. when running unit tests)
/* eslint-disable @typescript-eslint/no-var-requires */
let IS_BROWSER;
const crypto: Crypto = IS_BROWSER ? window.crypto : require('crypto').webcrypto;

export default crypto;
