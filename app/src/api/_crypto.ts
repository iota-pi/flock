// Hack to work around window.crypto being undefined in Node
// (e.g. when running unit tests)

const isNode = (typeof process !== 'undefined') && (process.release.name === 'node');

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

const crypto: Crypto = globalThis.crypto || window.crypto;
if (!crypto.subtle && isNode) {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires, global-require */
  (crypto as Writeable<Crypto>).subtle = require('node:crypto').webcrypto.subtle;
}

export default crypto;
