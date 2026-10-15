/// <reference lib="webworker" />
import wasmUrl from '@automerge/automerge/automerge.wasm?url'
import env from '../../env'
import { exposeSyncWorker } from '@vault/client/worker'
import { FLOCK_STORAGE_NAMES } from './storageNames'
import { flockSyncDomain } from './syncDomain'
import { hasLegacyLocalData, MIN_DATA_VERSION } from '../../migrate/detection'

exposeSyncWorker({
  automergeWasmUrl: wasmUrl,
  endpoint: env.VAULT_ENDPOINT,
  storageNames: FLOCK_STORAGE_NAMES,
  domain: flockSyncDomain,
  // Older local data goes through the migration app (src/migrate/) instead
  minDataVersion: MIN_DATA_VERSION,
  hasLegacyLocalData,
})
