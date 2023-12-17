// Hack to work around window.crypto being undefined in Node
// (e.g. when running unit tests)

const isNode = (typeof process !== 'undefined') && (process.release.name === 'node');

/* eslint-disable @typescript-eslint/no-var-requires, global-require */
const crypto: Crypto = globalThis.crypto || window.crypto;
if (!crypto.subtle && isNode) {
  (crypto as any).subtle = require('node:crypto').webcrypto.subtle;
}

export default crypto;
