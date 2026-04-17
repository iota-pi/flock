import { useCallback, useMemo, useState } from 'react'
import {
  setMetadata,
  storeItems,
} from '../features/items/mutations/itemMutations'
import { exportData } from '../api/vault'
import type { BackupPayloadV2, RestorePayload } from '../types/backup'
import type { Item } from '../state/items'
import {
  clearAutomergeDocStore,
  exportAllBinaries,
  getAutomergeItems,
  getAutomergeMetadata,
  restoreFromBinaries,
} from '../sync/automergeDocStore'
import { clearKnownAutomergeItemIds } from '../sync/automergeRepo'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import type { BaseToastMessage } from '../state/toastStore'

type SetMessage = (payload: BaseToastMessage) => void

type UseBackupAndRestoreOptions = {
  setMessage: SetMessage
}

type UseBackupAndRestoreResult = {
  actions: {
    handleClearCache: () => Promise<void>
    handleConfirmImport: (items: Item[]) => Promise<boolean>
    handleConfirmRestore: (payload: RestorePayload) => Promise<boolean>
    handleExport: () => Promise<string>
  }
  values: {
    itemCacheExists: boolean
  }
}

export default function useBackupAndRestore({
  setMessage,
}: UseBackupAndRestoreOptions): UseBackupAndRestoreResult {
  const [cacheClearCounter, setCacheClearCounter] = useState(1)

  const handleClearCache = useCallback(
    async () => {
      clearKnownAutomergeItemIds()
      await clearAutomergeDocStore()
      requestAutomergeSync()
      setCacheClearCounter(c => c + 1)
      setMessage({ message: 'Item cache cleared' })
    },
    [setMessage],
  )

  const handleExport = useCallback(
    async () => {
      try {
        const currentMetadata = getAutomergeMetadata()
        const documents = await exportAllBinaries()
        const backupPayload: BackupPayloadV2 = {
          version: 2,
          metadata: currentMetadata,
          documents,
        }

        const data = await exportData(backupPayload)
        const json = JSON.stringify(data)
        setMessage({ message: 'Backup created' })
        return json
      } catch (err) {
        setMessage({ message: 'Failed to create backup', severity: 'error' })
        throw err
      }
    },
    [setMessage],
  )

  const handleConfirmRestore = useCallback(
    async (payload: RestorePayload) => {
      try {
        if (payload.metadata) {
          await setMetadata(payload.metadata)
        }

        const restoredItemIds = await restoreFromBinaries(payload.documents)
        if (restoredItemIds.length > 0) {
          requestAutomergeSync(restoredItemIds)
        }

        setMessage({ message: 'Restore successful' })
        return true
      } catch (err) {
        setMessage({ message: 'Restore failed', severity: 'error' })
        console.error('Restore failed', err)
        return false
      }
    },
    [setMessage],
  )

  const handleConfirmImport = useCallback(
    async (imported: Item[]) => {
      try {
        await storeItems(imported)
        setMessage({ message: 'Import successful' })
        return true
      } catch (err) {
        setMessage({ message: 'Import failed', severity: 'error' })
        console.error('Import failed', err)
        return false
      }
    },
    [setMessage],
  )

  const itemCacheExists = useMemo(
    () => (cacheClearCounter ? getAutomergeItems().length > 0 : false),
    [cacheClearCounter],
  )

  return {
    actions: {
      handleClearCache,
      handleConfirmImport,
      handleConfirmRestore,
      handleExport,
    },
    values: {
      itemCacheExists,
    },
  }
}