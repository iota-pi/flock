import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  processOfflineQueue,
} from '../sync/offlineQueue'
import {
  type QueuedMutation,
  readDeadLetterQueue,
  readQueue,
  writeDeadLetterQueue,
  writeQueue,
} from '../sync/offlineQueueStore'
import { useUiStore } from '../state/uiStore'
import { queryClient, queryKeys } from '../api/queryClient'
import * as vault from '../api/vault'
import { Item } from '../state/items'
import type { ItemId } from '../shared/itemTypes'
import { getAccountId } from '../api/util'
import { fetchMany } from '../api/vault/client'
import { trpc } from '../api/trpc'

const MANUAL_RECOVERY_MUTATION_TYPE = 'items.manualRecovery'

export function useOfflineRecovery() {
  const trpcUtils = trpc.useUtils()
  const putItemMutation = trpc.items.put.useMutation()
  const resolveBranchConflictMutation = trpc.items.resolveBranchConflict.useMutation()
  const setDlqCount = useUiStore(state => state.setDlqCount)
  const setOfflineQueueLength = useUiStore(state => state.setOfflineQueueLength)
  const setMessage = useUiStore(state => state.setMessage)
  const [isRetrying, setIsRetrying] = useState<string | null>(null)

  const fetchDeadLetterItems = useCallback(async (): Promise<QueuedMutation[]> => {
    const items = await readDeadLetterQueue()
    setDlqCount(items.length)
    return items
  }, [setDlqCount])

  const {
    data: deadLetterItems = [],
    refetch: refetchDeadLetterItems,
  } = useQuery({
    queryKey: ['deadLetterQueue'],
    queryFn: fetchDeadLetterItems,
  })

  const handleRetryDeadLetterMutation = useCallback(async (id: string) => {
    setIsRetrying(id)
    try {
      const dlqItems = await readDeadLetterQueue()
      const mutation = dlqItems.find(item => item.id === id)
      if (!mutation) {
        await refetchDeadLetterItems()
        return
      }

      const nextDlqItems = dlqItems.filter(item => item.id !== id)
      const queueItems = await readQueue()
      queueItems.push(mutation)

      await writeQueue(queueItems)
      setOfflineQueueLength(queueItems.length)
      await writeDeadLetterQueue(nextDlqItems)
      setDlqCount(nextDlqItems.length)

      await processOfflineQueue()
      await refetchDeadLetterItems()
    } finally {
      setIsRetrying(current => (current === id ? null : current))
    }
  }, [refetchDeadLetterItems, setDlqCount, setOfflineQueueLength])

  const handleDiscardDeadLetterMutation = useCallback(async (id: string) => {
    const dlqItems = await readDeadLetterQueue()
    const nextDlqItems = dlqItems.filter(item => item.id !== id)
    await writeDeadLetterQueue(nextDlqItems)
    setDlqCount(nextDlqItems.length)
    await refetchDeadLetterItems()
  }, [refetchDeadLetterItems, setDlqCount])

  const removeManualRecoveryEntry = useCallback(async (itemId: ItemId) => {
    const dlqItems = await readDeadLetterQueue()
    const nextDlqItems = dlqItems.filter(item => !(
      item.mutationType === MANUAL_RECOVERY_MUTATION_TYPE
      && (item.payload as { itemId?: unknown })?.itemId === itemId
    ))
    await writeDeadLetterQueue(nextDlqItems)
    setDlqCount(nextDlqItems.length)
    await refetchDeadLetterItems()
  }, [refetchDeadLetterItems, setDlqCount])

  const handleForceOverwriteCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      const localItems = queryClient.getQueryData<Item[]>(queryKeys.items) || []
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
      setMessage({ message: `Deleted corrupted server item ${itemId}.` })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [putItemMutation, removeManualRecoveryEntry, setMessage, trpcUtils])

  return {
    deadLetterItems,
    isRetrying,
    handleRetryDeadLetterMutation,
    handleDiscardDeadLetterMutation,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
  }
}
