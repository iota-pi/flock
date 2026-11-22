// The engine loads Automerge's wasm from this URL. The `?url` import needs Vite (or a bundler that
// understands it) to build the library. Apps import it only to prefetch the wasm.
import automergeWasmUrl from '@automerge/automerge/automerge.wasm?url'

export { automergeWasmUrl }
