import { useCallback } from 'react'
import {
  setMetadata,
  storeItems,
} from '../features/items/mutations/itemMutations'
import { exportData } from '../api/vault'
import type { BackupPayloadV2, BackupSyncState } from '../types/backup'
import type { Item } from '../state/items'
import { SyncBridge } from '../sync/client/SyncBridge'
import { useAppStore } from '../state/store'
import type { BaseToastMessage } from '../state/slices/toastSlice'

type SetMessage = (payload: BaseToastMessage) => void

type UseBackupAndRestoreOptions = {
  setMessage: SetMessage
}

type UseBackupAndRestoreResult = {
  actions: {
    handleConfirmImport: (items: Item[]) => Promise<boolean>
    handleConfirmRestore: (payload: BackupPayloadV2) => Promise<boolean>
    handleExport: () => Promise<string>
  }
}

export default function useBackupAndRestore({
  setMessage,
}: UseBackupAndRestoreOptions): UseBackupAndRestoreResult {
  const handleExport = useCallback(
    async () => {
      try {
        const currentMetadata = useAppStore.getState().metadata
        const documents = await SyncBridge.exportAllBinaries()
        let syncState: BackupSyncState | undefined
        try {
          syncState = await SyncBridge.exportSyncState()
        } catch (e) {
          console.error('[useBackupAndRestore] Failed to export sync state', e)
        }

        const backupPayload: BackupPayloadV2 = {
          version: 2,
          metadata: currentMetadata,
          documents,
          cursors: syncState?.cursors,
          pendingSync: syncState?.pendingSync,
          lastModified: syncState?.lastModified,
        }

        const data = await exportData(backupPayload)
        const json = JSON.stringify(data)

        if (syncState?.pendingSync && syncState.pendingSync.length > 0) {
          setMessage({
            message: 'You have unsent offline changes. Please connect to the internet to sync before exporting a backup.',
            severity: 'warning',
          })
        } else {
          setMessage({ message: 'Backup created' })
        }

        return json
      } catch (err) {
        setMessage({ message: 'Failed to create backup', severity: 'error' })
        throw err
      }
    },
    [setMessage],
  )

  const handleConfirmRestore = useCallback(
    async (payload: BackupPayloadV2) => {
      try {
        if (payload.metadata) {
          await setMetadata(payload.metadata)
        }

        await SyncBridge.restoreFromBinaries(payload.documents)

        if (payload.cursors || payload.pendingSync || payload.lastModified) {
          await SyncBridge.restoreSyncState({
            cursors: payload.cursors,
            pendingSync: payload.pendingSync,
            lastModified: payload.lastModified,
          })
        }

        await SyncBridge.forceSync()

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

  return {
    actions: {
      handleConfirmImport,
      handleConfirmRestore,
      handleExport,
    },
  }
}