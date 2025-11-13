// Hack to work around TextEncoder/TextDecoder being undefined in Node
// (e.g. when running unit tests)

const enc: typeof TextEncoder = globalThis.window?.TextEncoder || (await import('util')).TextEncoder
const dec: typeof TextDecoder = globalThis.window?.TextDecoder || (await import('util')).TextDecoder

export { enc as TextEncoder }
export { dec as TextDecoder }
