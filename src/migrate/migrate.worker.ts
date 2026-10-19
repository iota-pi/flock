/// <reference lib="webworker" />
import wasmUrl from '@automerge/automerge/automerge.wasm?url'
import env from '../env'
import { exposeSyncWorker } from '@vault/client/worker'
import { FLOCK_STORAGE_NAMES } from '../app/vault/storageNames'
import { flockSyncDomain } from '../app/vault/syncDomain'
import { decodeLegacyCipherItem } from './legacy/legacyItems'
import { flockLegacySettings } from './legacy/legacySettings'
import { migrateLegacyLocalData } from './legacy/localData'
import { SEALED_DATA_VERSION } from '../shared/flockDataVersion'

// The main app's engine plus every legacy hook. No `minDataVersion`: this is where data below it goes.
exposeSyncWorker({
  automergeWasmUrl: wasmUrl,
  endpoint: env.VAULT_ENDPOINT,
  storageNames: FLOCK_STORAGE_NAMES,
  domain: {
    ...flockSyncDomain,
    decodeLegacyItem: decodeLegacyCipherItem,
    legacySettings: flockLegacySettings,
  },
  migrateLocalData: migrateLegacyLocalData,
  upgradeSnapshotFormat: true,
  // A device that synced today would otherwise skip the manifest, and with it any legacy rows
  fetchManifestEverySync: true,
  // As the main app does, so the two never disagree about where this device's data is
  upgradeLocalEncryption: true,
  sealedDataVersion: SEALED_DATA_VERSION,
})
