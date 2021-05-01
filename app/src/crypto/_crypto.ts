// Hack to work around window.crypto being undefined in Node (e.g. when running unit tests)
/* eslint-disable @typescript-eslint/no-var-requires */
const crypto: Crypto = window.crypto || require('crypto').webcrypto;

export default crypto;
