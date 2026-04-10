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
  applyAutomergeItemPatches,
  getAutomergeItem,
  type AutomergeDocumentPatch,
} from '../sync/automergeDocStore'

function buildReplaceAllPatches(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): AutomergeDocumentPatch[] {
  const patches: AutomergeDocumentPatch[] = []

  for (const key of Object.keys(previous)) {
    if (!(key in next) || next[key] === undefined) {
      patches.push({
        op: 'remove',
        path: [key],
      })
    }
  }

  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      continue
    }

    patches.push({
      op: key in previous ? 'replace' : 'add',
      path: [key],
      value,
    })
  }

  return patches
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

      const patches = buildReplaceAllPatches(
        (getAutomergeItem(itemId) as unknown as Record<string, unknown>) || {},
        localSnapshot,
      )

      await applyAutomergeItemPatches(itemId, patches)

      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync([itemId])
      setMessage({ message: `Recovered ${itemId} using local cache.` })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [removeManualRecoveryEntry, setMessage])

  const handleForceDeleteCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      const existing = getAutomergeItem(itemId)

      await applyAutomergeItemPatches(itemId, [
        {
          op: 'replace',
          path: ['id'],
          value: itemId,
        },
        {
          op: 'replace',
          path: ['type'],
          value: existing?.type || 'person',
        },
        {
          op: 'replace',
          path: ['deleted'],
          value: true,
        },
      ])

      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync([itemId])
      setMessage({ message: `Deleted corrupted server item ${itemId}.` })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [removeManualRecoveryEntry, setMessage])

  const handleRetryCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync([itemId])
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
