// Key derivation worker entry point: an app's KDF worker calls `exposeKdfWorker`, and passes a
// factory for that worker to `configureVaultHost({ createKdfWorker })`.
import * as Comlink from 'comlink'
import { computeArgon2id, type KdfWorkerApi } from './api/kdf'

export function exposeKdfWorker(): void {
  const api: KdfWorkerApi = { deriveArgon2id: computeArgon2id }
  Comlink.expose(api)
}
