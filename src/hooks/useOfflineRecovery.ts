import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  type ManualRecoveryEntry,
  readManualRecoveryCount,
  readManualRecoveryEntries,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
} from '../sync/manualRecoveryStore'
import { useSyncStore } from '../state/syncStore'
import { useToastStore } from '../state/toastStore'
import type { ItemId } from '../shared/itemTypes'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { getAutomergeItem, withAutomergeItemChange } from '../sync/automergeDocStore'

export function useOfflineRecovery() {
  const setRecoveryCount = useSyncStore(state => state.setRecoveryCount)
  const setMessage = useToastStore(state => state.setMessage)
  const [isRetrying, setIsRetrying] = useState<string | null>(null)

  const fetchManualRecoveryItems = useCallback(async (): Promise<ManualRecoveryEntry[]> => {
    const items = await readManualRecoveryEntries()
    setRecoveryCount(items.length)
    return items
  }, [setRecoveryCount])

  const {
    data: recoveryItems = [],
    refetch: refetchRecoveryItems,
  } = useQuery({
    queryKey: ['manualRecoveryItems'],
    queryFn: fetchManualRecoveryItems,
  })

  const refreshRecoveryCount = useCallback(async () => {
    setRecoveryCount(await readManualRecoveryCount())
  }, [setRecoveryCount])

  const removeManualRecoveryEntry = useCallback(async (itemId: ItemId) => {
    await removeManualRecoveryEntryByItemId(itemId)
    await refreshRecoveryCount()
    await refetchRecoveryItems()
  }, [refetchRecoveryItems, refreshRecoveryCount])

  const handleDismissRecoveryItem = useCallback(async (id: string) => {
    await removeManualRecoveryEntryById(id)
    await refreshRecoveryCount()
    await refetchRecoveryItems()
  }, [refetchRecoveryItems, refreshRecoveryCount])

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

      await withAutomergeItemChange(itemId, draft => {
        for (const key of Object.keys(draft)) {
          delete draft[key]
        }

        Object.assign(draft, localItem as unknown as Record<string, unknown>)
        draft.prayedFor = [...localItem.prayedFor]
      })

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

      await withAutomergeItemChange(itemId, draft => {
        draft.id = itemId
        draft.type = existing?.type || 'person'
        draft.deleted = true
      })

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
