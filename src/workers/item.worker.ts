import { FilterCriterion, filterItems } from '../utils/customFilter'
import { SortCriterion, sortItems } from '../utils/customSort'
import { Item } from '../state/items'
import * as Automerge from '@automerge/automerge'
import { expose } from 'comlink'

const workerApi = {
  processItems(input: {
    items: Item[]
    filters?: FilterCriterion[]
    sortCriteria?: SortCriterion[]
    showArchived?: boolean
  }) {
    const items = input.items
    const filters = input.filters || []
    const sortCriteria = input.sortCriteria || []
    const showArchived = !!input.showArchived

    const archivedCount = items.filter(i => i.archived).length
    const preFiltered = showArchived ? items : items.filter(i => !i.archived)
    const totalApplicable = preFiltered.length
    const filtered = filterItems(preFiltered, filters)
    const results = sortItems(filtered, sortCriteria)

    return {
      results,
      totalApplicable,
      archivedCount,
    }
  },

  seedAutomerge(items: Item[]) {
    return items.map(item => {
      const doc = Automerge.from(item as unknown as Record<string, unknown>)
      const binary = Automerge.save(doc)
      return {
        id: item.id,
        binary,
      }
    })
  },
}

expose(workerApi)
