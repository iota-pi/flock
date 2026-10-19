/// <reference lib="webworker" />
import wasmUrl from '@automerge/automerge/automerge.wasm?url'
import env from '../../env'
import { exposeSyncWorker } from '@vault/client/worker'
import { FLOCK_STORAGE_NAMES } from './storageNames'
import { flockSyncDomain } from './syncDomain'
import { hasLegacyLocalData, MIN_DEVICE_DATA_VERSION } from '../../migrate/detection'
import { SEALED_DATA_VERSION } from '../../shared/flockDataVersion'

exposeSyncWorker({
  automergeWasmUrl: wasmUrl,
  endpoint: env.VAULT_ENDPOINT,
  storageNames: FLOCK_STORAGE_NAMES,
  domain: flockSyncDomain,
  // Older local data goes through the migration app (src/migrate/) instead
  minDataVersion: MIN_DEVICE_DATA_VERSION,
  hasLegacyLocalData,
  // Devices upgrade the next time they unlock. The migration app seals too, so it never finds the
  // plaintext stores gone and downloads everything into new ones.
  upgradeLocalEncryption: true,
  sealedDataVersion: SEALED_DATA_VERSION,
})
