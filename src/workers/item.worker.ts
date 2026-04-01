import { FilterCriterion, filterItems } from '../utils/customFilter'
import { SortCriterion, sortItems } from '../utils/customSort'
import { Item } from '../state/items'
import * as Automerge from '@automerge/automerge'

self.onmessage = (e: MessageEvent) => {
  const message = e.data as {
    jobId: number
    type?: 'PROCESS_ITEMS' | 'SEED_AUTOMERGE'
    items: Item[]
    filters?: FilterCriterion[]
    sortCriteria?: SortCriterion[]
    showArchived?: boolean
  }

  const { jobId, type = 'PROCESS_ITEMS', items } = message

  if (type === 'SEED_AUTOMERGE') {
    const seeded = items.map(item => {
      const doc = Automerge.from(item as unknown as Record<string, unknown>)
      const binary = Automerge.save(doc)
      return {
        id: item.id,
        binary,
      }
    })

    self.postMessage({
      type,
      jobId,
      seeded,
    })
    return
  }

  const filters = message.filters || []
  const sortCriteria = message.sortCriteria || []
  const showArchived = !!message.showArchived

  // Calculate archived count
  const archivedCount = items.filter(i => i.archived).length

  // First filter by archived status
  const preFiltered = showArchived ? items : items.filter(i => !i.archived)
  const totalApplicable = preFiltered.length

  // Then apply user filters
  const filtered = filterItems(preFiltered, filters)
  const sorted = sortItems(filtered, sortCriteria)

  self.postMessage({ type, jobId, results: sorted, totalApplicable, archivedCount })
}
