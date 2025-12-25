import { useEffect, useRef, useState } from 'react'
import { Item } from '../state/items'
import { FilterCriterion } from '../utils/customFilter'
import { SortCriterion } from '../utils/customSort'

interface UseAsyncItemsProps<T extends Item> {
  items: T[],
  filters: FilterCriterion[],
  sortCriteria: SortCriterion[],
}

export function useAsyncItems<T extends Item>({
  items,
  filters,
  sortCriteria,
}: UseAsyncItemsProps<T>) {
  const [processedItems, setProcessedItems] = useState<T[]>(items)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    workerRef.current = new Worker(new URL('../workers/item.worker.ts', import.meta.url), {
      type: 'module',
    })

    workerRef.current.onmessage = e => {
      setProcessedItems(e.data)
    }

    return () => {
      workerRef.current?.terminate()
    }
  }, [])

  useEffect(() => {
    workerRef.current?.postMessage({ items, filters, sortCriteria })
  }, [items, filters, sortCriteria])

  return processedItems
}
