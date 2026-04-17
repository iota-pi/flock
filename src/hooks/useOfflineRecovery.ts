import { useCallback, useEffect, useState } from 'react'
import {
  type ManualRecoveryEntry,
  readManualRecoveryEntries,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
} from '../sync/manualRecoveryStore'
import { useToastStore } from '../state/toastStore'
import type { ItemId } from '../shared/itemTypes'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import {
  getAutomergeItem,
  withAutomergeDocumentChange,
} from '../sync/automergeDocStore'

function mutateDraftToMatchSnapshot(
  draft: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(draft)) {
    if (!(key in snapshot) || snapshot[key] === undefined) {
      delete draft[key]
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      draft[key] = value
    }
  }
}

export function useOfflineRecovery() {
  const setMessage = useToastStore(state => state.setMessage)
  const [isRetrying, setIsRetrying] = useState<string | null>(null)
  const [recoveryItems, setRecoveryItems] = useState<ManualRecoveryEntry[]>([])

  const refreshRecoveryItems = useCallback(async (): Promise<ManualRecoveryEntry[]> => {
    const next = await readManualRecoveryEntries()
    setRecoveryItems(next)
    return next
  }, [])

  useEffect(() => {
    void refreshRecoveryItems()
  }, [refreshRecoveryItems])

  const removeManualRecoveryEntry = useCallback(async (itemId: ItemId) => {
    await removeManualRecoveryEntryByItemId(itemId)
    await refreshRecoveryItems()
  }, [refreshRecoveryItems])

  const handleDismissRecoveryItem = useCallback(async (id: string) => {
    await removeManualRecoveryEntryById(id)
    await refreshRecoveryItems()
  }, [refreshRecoveryItems])

  const handleForceOverwriteCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      const localItem = getAutomergeItem(itemId)
      if (!localItem) {
        setMessage({
          severity: 'error',
          message: `No local item found for ${itemId}. Force delete is available instead.`,
        })
        return
      }

      const localSnapshot = JSON.parse(JSON.stringify(localItem)) as Record<string, unknown>
      if (Array.isArray(localItem.prayedFor)) {
        localSnapshot.prayedFor = [...localItem.prayedFor]
      }

      await withAutomergeDocumentChange(
        itemId,
        doc => {
          mutateDraftToMatchSnapshot(doc, localSnapshot)
          if (typeof doc.id !== 'string' || doc.id.length === 0) {
            doc.id = itemId
          }
        },
        {
          createIfMissing: true,
          initialValue: { id: itemId },
        },
      )

      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync()
      setMessage({ message: `Recovered ${itemId} using local cache.` })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [removeManualRecoveryEntry, setMessage])

  const handleForceDeleteCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      const existing = getAutomergeItem(itemId)

      await withAutomergeDocumentChange(
        itemId,
        doc => {
          doc.id = itemId
          doc.type = existing?.type || 'person'
          doc.deleted = true
        },
        {
          createIfMissing: true,
          initialValue: {
            id: itemId,
          },
        },
      )

      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync()
      setMessage({ message: `Deleted corrupted server item ${itemId}.` })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [removeManualRecoveryEntry, setMessage])

  const handleRetryCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync()
      setMessage({
        severity: 'info',
        message: `Retry sync triggered for ${itemId}.`,
      })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [removeManualRecoveryEntry, setMessage])

  return {
    recoveryItems,
    isRetrying,
    handleDismissRecoveryItem,
    handleRetryCorruptedItem,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
  }
}
