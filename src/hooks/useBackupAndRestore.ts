import { useCallback, useMemo, useState } from 'react'
import {
  mutateSetMetadata,
  mutateStoreItems,
} from '../features/items/mutations/itemMutations'
import { exportData } from '../api/vault'
import type { BackupPayloadV1, RestorePayload } from '../types/backup'
import type { Item } from '../state/items'
import { clearAutomergeDocStore, getAutomergeItems } from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { clearMetadataCache, getCachedMetadata } from '../api/itemReadService'
import type { BaseToastMessage } from '../state/toastStore'

type SetMessage = (payload: BaseToastMessage) => void

type UseBackupAndRestoreOptions = {
  items: Item[]
  setMessage: SetMessage
}

type UseBackupAndRestoreResult = {
  actions: {
    handleClearCache: () => Promise<void>
    handleConfirmImport: (items: Item[]) => Promise<boolean>
    handleConfirmRestore: (payload: Partial<RestorePayload> & Pick<RestorePayload, 'items'>) => Promise<boolean>
    handleExport: () => Promise<string>
  }
  values: {
    itemCacheExists: boolean
  }
}

export default function useBackupAndRestore({
  items,
  setMessage,
}: UseBackupAndRestoreOptions): UseBackupAndRestoreResult {
  const [cacheClearCounter, setCacheClearCounter] = useState(1)

  const handleClearCache = useCallback(
    async () => {
      await clearAutomergeDocStore()
      clearMetadataCache()
      requestAutomergeSync()
      setCacheClearCounter(c => c + 1)
      setMessage({ message: 'Item cache cleared' })
    },
    [setMessage],
  )

  const handleExport = useCallback(
    async () => {
      try {
        const currentMetadata = getCachedMetadata()
        const backupPayload: BackupPayloadV1 = {
          version: 1,
          metadata: currentMetadata,
          items,
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
    [items, setMessage],
  )

  const handleConfirmRestore = useCallback(
    async ({
      items: restoredItems,
      metadata,
    }: Partial<RestorePayload> & Pick<RestorePayload, 'items'>) => {
      try {
        if (metadata) {
          await mutateSetMetadata(metadata)
        }

        await mutateStoreItems(restoredItems)

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
        await mutateStoreItems(imported)
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