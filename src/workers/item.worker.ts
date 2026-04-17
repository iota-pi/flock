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
  }) {
    const items = input.items
    const filters = input.filters || []
    const sortCriteria = input.sortCriteria || []

    const archivedCount = items.filter(i => i.archived).length
    const totalApplicable = items.length
    const filtered = filterItems(items, filters)
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
