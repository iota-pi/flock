import { useEffect, useMemo, useState } from 'react'
import { Item } from '../state/items'
import { FilterCriterion } from '../utils/customFilter'
import { SortCriterion } from '../utils/customSort'
import { processItemsWithWorker } from '../workers/itemWorkerManager'

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
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters])
  const sortCriteriaKey = useMemo(() => JSON.stringify(sortCriteria), [sortCriteria])
  const stableFilters = useMemo(() => JSON.parse(filtersKey) as FilterCriterion[], [filtersKey])
  const stableSortCriteria = useMemo(() => JSON.parse(sortCriteriaKey) as SortCriterion[], [sortCriteriaKey])

  useEffect(() => {
    let cancelled = false

    void processItemsWithWorker({ items, filters: stableFilters, sortCriteria: stableSortCriteria, showArchived })
      .then(result => {
        if (cancelled) {
          return
        }

        setProcessedItems(result.results as T[])
        setTotalApplicable(result.totalApplicable)
        setArchivedCount(result.archivedCount)
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        const fallbackItems = showArchived ? items : items.filter(i => !i.archived)
        setProcessedItems(fallbackItems as T[])
        setTotalApplicable(fallbackItems.length)
        setArchivedCount(items.filter(i => i.archived).length)
      })

    return () => {
      cancelled = true
    }
  }, [items, showArchived, stableFilters, stableSortCriteria])

  return { items: processedItems, totalApplicable, archivedCount }
}
