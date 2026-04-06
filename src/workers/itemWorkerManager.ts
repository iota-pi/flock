import type { Item } from '../state/items'
import type { FilterCriterion } from '../utils/customFilter'
import type { SortCriterion } from '../utils/customSort'
import { wrap, type Remote } from 'comlink'

type ItemWorkerApi = {
  processItems: (input: {
    items: Item[]
    filters: FilterCriterion[]
    sortCriteria: SortCriterion[]
    showArchived: boolean
  }) => Promise<{
    results: Item[]
    totalApplicable: number
    archivedCount: number
  }>
  seedAutomerge: (items: Item[]) => Promise<Array<{
    id: string
    binary: Uint8Array
  }>>
}

let worker: Worker | null = null
let workerApi: Remote<ItemWorkerApi> | null = null

function getWorkerApi() {
  if (workerApi) {
    return workerApi
  }

  worker = new Worker(new URL('./item.worker.ts', import.meta.url), {
    type: 'module',
  })
  workerApi = wrap<ItemWorkerApi>(worker)

  worker.onerror = event => {
    console.error(event.message || 'Item worker failed')
    worker = null
    workerApi = null
  }

  return workerApi
}

export async function processItemsWithWorker(input: {
  items: Item[]
  filters: FilterCriterion[]
  sortCriteria: SortCriterion[]
  showArchived: boolean
}): Promise<{
  results: Item[]
  totalApplicable: number
  archivedCount: number
}> {
  const api = getWorkerApi()
  return api.processItems(input)
}

export async function seedAutomergeBinaryWithWorker(items: Item[]): Promise<Array<{ id: string; binary: Uint8Array }>> {
  if (items.length === 0) {
    return []
  }

  const api = getWorkerApi()
  return api.seedAutomerge(items)
}
