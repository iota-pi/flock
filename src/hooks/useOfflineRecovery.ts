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
import { queryClient } from '../api/queryClient'
import * as vault from '../api/vault'
import { Item } from '../state/items'
import type { ItemId } from '../shared/itemTypes'
import { getAccountId } from '../api/util'
import { fetchMany } from '../api/vault/client'
import { trpc } from '../api/trpc'
import { getQueryKey } from '@trpc/react-query'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'

export function useOfflineRecovery() {
  const trpcUtils = trpc.useUtils()
  const putItemMutation = trpc.items.put.useMutation()
  const resolveBranchConflictMutation = trpc.items.resolveBranchConflict.useMutation()
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
      const localItems = queryClient.getQueryData<Item[]>(getQueryKey(trpc.items.fetchMany)) || []
      const localItem = localItems.find(item => item.id === itemId)
      if (!localItem) {
        setMessage({
          severity: 'error',
          message: `No local cache found for ${itemId}. Force delete is available instead.`,
        })
        return
      }

      const serverItems = await fetchMany({ ids: [itemId] }).then(response => response.items)
      const serverItem = serverItems.find(item => item.item === itemId)

      const encrypted = await vault.encryptObjectAsAutomerge(localItem)
      const resolvedBranch = {
        encryptedAutomergeDoc: encrypted.encryptedAutomergeDoc,
        versionId: encrypted.versionId,
        parentIds: serverItem?.branches?.map(branch => branch.versionId) || [],
      }

      const account = getAccountId()
      if (resolvedBranch.parentIds.length > 0) {
        await resolveBranchConflictMutation.mutateAsync({
          account,
          resolutions: [{ item: itemId, resolvedBranch }],
          idempotencyKey: `manual-recovery-overwrite-${itemId}-${Date.now()}`,
        })
      } else {
        await putItemMutation.mutateAsync({
          account,
          item: itemId,
          branches: [resolvedBranch],
          modified: Date.now(),
          type: localItem.type,
          deleted: localItem.deleted,
          idempotencyKey: `manual-recovery-put-${itemId}-${Date.now()}`,
        })
      }

      await trpcUtils.items.fetchMany.invalidate()
      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync([itemId])
      setMessage({ message: `Recovered ${itemId} using local cache.` })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [putItemMutation, removeManualRecoveryEntry, resolveBranchConflictMutation, setMessage, trpcUtils])

  const handleForceDeleteCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      const serverItems = await fetchMany({ ids: [itemId] }).then(response => response.items)
      const serverItem = serverItems.find(item => item.item === itemId)
      const fallbackType = serverItem?.metadata?.type || 'person'
      const deletedPayload = await vault.encryptObjectAsAutomerge({
        id: itemId,
        type: fallbackType,
        deleted: true,
      })

      await putItemMutation.mutateAsync({
        account: getAccountId(),
        item: itemId,
        branches: [{
          encryptedAutomergeDoc: deletedPayload.encryptedAutomergeDoc,
          versionId: deletedPayload.versionId,
          parentIds: serverItem?.branches?.map(branch => branch.versionId) || [],
        }],
        modified: Date.now(),
        type: fallbackType,
        deleted: true,
        idempotencyKey: `manual-recovery-delete-${itemId}-${Date.now()}`,
      })

      await trpcUtils.items.fetchMany.invalidate()
      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync([itemId])
      setMessage({ message: `Deleted corrupted server item ${itemId}.` })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [putItemMutation, removeManualRecoveryEntry, setMessage, trpcUtils])

  const handleRetryCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      await removeManualRecoveryEntry(itemId)
      requestAutomergeSync([itemId])
      await trpcUtils.items.fetchMany.invalidate()
      setMessage({
        severity: 'info',
        message: `Retry sync triggered for ${itemId}.`,
      })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [removeManualRecoveryEntry, setMessage, trpcUtils])

  return {
    recoveryItems,
    isRetrying,
    handleDismissRecoveryItem,
    handleRetryCorruptedItem,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
  }
}
