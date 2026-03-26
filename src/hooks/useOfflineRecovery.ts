import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  type QueuedMutation,
  readDeadLetterQueue,
  readQueue,
  writeDeadLetterQueue,
  writeQueue,
} from '../api/offlineQueueStore'
import { processOfflineQueue } from '../api/offlineQueue'
import { useUiStore } from '../state/uiStore'

export function useOfflineRecovery() {
  const setDlqCount = useUiStore(state => state.setDlqCount)
  const setOfflineQueueLength = useUiStore(state => state.setOfflineQueueLength)
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

  return {
    deadLetterItems,
    isRetrying,
    handleRetryDeadLetterMutation,
    handleDiscardDeadLetterMutation,
  }
}
