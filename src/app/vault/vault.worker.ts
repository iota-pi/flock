/// <reference lib="webworker" />
import wasmUrl from '@automerge/automerge/automerge.wasm?url'
import env from '../../env'
import { exposeSyncWorker } from '../../sync/worker/sync.worker'
import { FLOCK_STORAGE_NAMES } from './storageNames'
import { flockSyncDomain } from './syncDomain'
import { migrateLegacyLocalData } from './legacy/localData'

exposeSyncWorker({
  automergeWasmUrl: wasmUrl,
  endpoint: env.VAULT_ENDPOINT,
  storageNames: FLOCK_STORAGE_NAMES,
  domain: flockSyncDomain,
  migrateLocalData: migrateLegacyLocalData,
})
