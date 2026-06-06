import { useCallback, useEffect, useState } from 'react'
import type { ManualRecoveryEntry } from '../sync/manualRecoveryStore'
import { useToastStore } from '../state/toastStore'
import { SyncBridge } from '../sync/SyncBridge'
import { ItemId } from 'src/shared/schemas/items'


export function useDataRecovery() {
  const setMessage = useToastStore(state => state.setMessage)
  const [isRetrying, setIsRetrying] = useState<string | null>(null)
  const [recoveryItems, setRecoveryItems] = useState<ManualRecoveryEntry[]>([])

  useEffect(() => {
    // Fetch initial list
    void SyncBridge.listRecoveryItems().catch(console.error)

    // Subscribe to live updates from SyncBridge
    const unsubscribe = SyncBridge.subscribeRecoveryItems(entries => {
      setRecoveryItems(entries)
    })

    return unsubscribe
  }, [])

  const handleDismissRecoveryItem = useCallback(async (id: string) => {
    try {
      await SyncBridge.dismissRecoveryItem(id)
    } catch (error: unknown) {
      setMessage({
        severity: 'error',
        message: (error as Error).message || `Failed to dismiss recovery item.`,
      })
    }
  }, [setMessage])

  const handleForceOverwriteCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      await SyncBridge.forceOverwriteRecoveryItem(itemId)
      setMessage({ message: `Recovered ${itemId} using local cache.` })
    } catch (error: unknown) {
      setMessage({
        severity: 'error',
        message: (error as Error).message || `Failed to overwrite ${itemId}.`,
      })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [setMessage])

  const handleForceDeleteCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      await SyncBridge.forceDeleteRecoveryItem(itemId)
      setMessage({ message: `Deleted corrupted server item ${itemId}.` })
    } catch (error: unknown) {
      setMessage({
        severity: 'error',
        message: (error as Error).message || `Failed to force delete ${itemId}.`,
      })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [setMessage])

  const handleRetryCorruptedItem = useCallback(async (itemId: ItemId) => {
    setIsRetrying(itemId)
    try {
      await SyncBridge.retryRecoveryItem(itemId)
      setMessage({
        severity: 'info',
        message: `Retry queued for ${itemId}.`,
      })
    } catch (error: unknown) {
      setMessage({
        severity: 'error',
        message: (error as Error).message || `Failed to retry ${itemId}.`,
      })
    } finally {
      setIsRetrying(current => (current === itemId ? null : current))
    }
  }, [setMessage])

  return {
    recoveryItems,
    isRetrying,
    handleDismissRecoveryItem,
    handleRetryCorruptedItem,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
  }
}

