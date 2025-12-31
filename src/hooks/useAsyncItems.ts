import { useEffect, useRef, useState } from 'react'
import { Item } from '../state/items'
import { FilterCriterion } from '../utils/customFilter'
import { SortCriterion } from '../utils/customSort'

interface UseAsyncItemsProps<T extends Item> {
  items: T[],
  filters: FilterCriterion[],
  sortCriteria: SortCriterion[],
  showArchived: boolean,
}

export function useAsyncItems<T extends Item>({
  items,
  filters,
  sortCriteria,
  showArchived,
}: UseAsyncItemsProps<T>) {
  const [processedItems, setProcessedItems] = useState<T[]>(() => (
    showArchived ? items : items.filter(i => !i.archived) as T[]
  ))
  const [totalApplicable, setTotalApplicable] = useState(() => (
    showArchived ? items.length : items.filter(i => !i.archived).length
  ))
  const [archivedCount, setArchivedCount] = useState(() => (
    items.filter(i => i.archived).length
  ))
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    workerRef.current = new Worker(new URL('../workers/item.worker.ts', import.meta.url), {
      type: 'module',
    })

    workerRef.current.onmessage = e => {
      const { results, totalApplicable, archivedCount } = e.data
      setProcessedItems(results)
      setTotalApplicable(totalApplicable)
      setArchivedCount(archivedCount)
    }

    return () => {
      workerRef.current?.terminate()
    }
  }, [])

  useEffect(() => {
    workerRef.current?.postMessage({ items, filters, sortCriteria, showArchived })
  }, [items, filters, sortCriteria, showArchived])

  return { items: processedItems, totalApplicable, archivedCount }
}
