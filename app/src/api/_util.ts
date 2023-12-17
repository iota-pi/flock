// Hack to work around TextEncoder/TextDecoder being undefined in Node
// (e.g. when running unit tests)

/* eslint-disable @typescript-eslint/no-var-requires, global-require */
const enc: typeof TextEncoder = globalThis.window?.TextEncoder || require('util').TextEncoder;
const dec: typeof TextDecoder = globalThis.window?.TextDecoder || require('util').TextDecoder;

export { enc as TextEncoder };
export { dec as TextDecoder };
