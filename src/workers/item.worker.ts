import { FilterCriterion, filterItems } from '../utils/customFilter'
import { SortCriterion, sortItems } from '../utils/customSort'
import { Item } from '../state/items'

self.onmessage = (e: MessageEvent) => {
  const { items, filters, sortCriteria } = e.data as {
    items: Item[],
    filters: FilterCriterion[],
    sortCriteria: SortCriterion[],
  }

  const filtered = filterItems(items, filters)
  const sorted = sortItems(filtered, sortCriteria)

  self.postMessage(sorted)
}
