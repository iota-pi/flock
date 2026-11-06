import { useCallback } from 'react'
import {
  setMetadata,
  storeItems,
} from '../features/items/mutations/itemMutations'
import { exportData } from '@vault/client'
import { createLogger } from 'src/utils/logger'
import type { BackupPayloadV2 } from '../types/backup'
import type { BackupSyncState } from '@vault/client'
import type { Item } from '../state/items'
import { quietBackupReminder } from '../app/vault/backupReminderStore'
import { SyncBridge } from '../app/vault/syncBridge'
import { useAppStore } from '../state/store'
import type { BaseToastMessage } from '../state/slices/toastSlice'

const log = createLogger('useBackupAndRestore')

export const BACKUP_FILE_NAME = 'flock.backup.json'

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
        const { account, metadata: currentMetadata } = useAppStore.getState()
        const { documents, skipped } = await SyncBridge.exportAllBinaries()
        let syncState: BackupSyncState | undefined
        try {
          syncState = await SyncBridge.exportSyncState()
        } catch (e) {
          log.error('Failed to export sync state', e)
        }

        const backupPayload: BackupPayloadV2 = {
          version: 2,
          metadata: currentMetadata,
          documents,
          cursors: syncState?.cursors,
          lastModified: syncState?.lastModified,
        }

        const data = await exportData(backupPayload)
        const json = JSON.stringify(data)
        const unsynced = await SyncBridge.getUnsyncedChanges().catch((e: unknown) => {
          log.error('Failed to count unsynced changes', e)
          return null
        })

        // A backup missing items doesn't count, so the reminder keeps suggesting a complete one
        if (!skipped?.length) quietBackupReminder(account)

        if (skipped && skipped.length > 0) {
          setMessage({
            message: `Backup created, but ${skipped.length} item${skipped.length === 1 ? '' : 's'} could not be loaded.`,
            severity: 'warning',
          })
        } else if (unsynced && unsynced.pendingItems > 0) {
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

        if (payload.lastModified) {
          await SyncBridge.restoreSyncState({ lastModified: payload.lastModified })
        }

        await SyncBridge.flushSync()

        setMessage({ message: 'Restore successful' })
        return true
      } catch (err) {
        setMessage({ message: 'Restore failed', severity: 'error' })
        log.error('Restore failed', err)
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
        log.error('Import failed', err)
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