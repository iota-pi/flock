import { FilterCriterion, filterItems } from '../utils/customFilter'
import { SortCriterion, sortItems } from '../utils/customSort'
import { Item } from '../state/items'

self.onmessage = (e: MessageEvent) => {
  const { items, filters, sortCriteria, showArchived } = e.data as {
    items: Item[],
    filters: FilterCriterion[],
    sortCriteria: SortCriterion[],
    showArchived: boolean,
  }

  // Calculate archived count
  const archivedCount = items.filter(i => i.archived).length

  // First filter by archived status
  const preFiltered = showArchived ? items : items.filter(i => !i.archived)
  const totalApplicable = preFiltered.length

  // Then apply user filters
  const filtered = filterItems(preFiltered, filters)
  const sorted = sortItems(filtered, sortCriteria)

  self.postMessage({ results: sorted, totalApplicable, archivedCount })
}
