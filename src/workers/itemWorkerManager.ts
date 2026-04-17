import type { Item } from '../state/items'
import type { FilterCriterion } from '../utils/customFilter'
import type { SortCriterion } from '../utils/customSort'
import { filterItems } from '../utils/customFilter'
import { sortItems } from '../utils/customSort'
import * as Automerge from '@automerge/automerge'
import { wrap, type Remote } from 'comlink'

type ItemWorkerApi = {
  processItems: (input: ProcessItemsInput) => Promise<ProcessItemsResult>
  seedAutomerge: (items: Item[]) => Promise<Array<{
    id: string
    binary: Uint8Array
  }>>
}

export type ProcessItemsInput = {
  items: Item[]
  filters: FilterCriterion[]
  sortCriteria: SortCriterion[]
  showArchived: boolean
}

export type ProcessItemsResult = {
  results: Item[]
  totalApplicable: number
  archivedCount: number
}

const WORKER_MIN_ITEM_COUNT = 120

let worker: Worker | null = null
let workerApi: Remote<ItemWorkerApi> | null = null

function resetWorker(reason: string, error?: unknown): void {
  if (error) {
    console.error(reason, error)
  } else {
    console.error(reason)
  }

  ;(worker as { terminate?: () => void } | null)?.terminate?.()
  worker = null
  workerApi = null
}

export function processItemsSnapshot(input: ProcessItemsInput): ProcessItemsResult {
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
}

function seedAutomergeSynchronously(items: Item[]): Array<{ id: string; binary: Uint8Array }> {
  return items.map(item => {
    const doc = Automerge.from(item as unknown as Record<string, unknown>)
    const binary = Automerge.save(doc)
    return {
      id: item.id,
      binary,
    }
  })
}

function getWorkerApi(): Remote<ItemWorkerApi> | null {
  if (workerApi) {
    return workerApi
  }

  try {
    worker = new Worker(new URL('./item.worker.ts', import.meta.url), {
      type: 'module',
    })

    const wrappedApi = wrap<ItemWorkerApi>(worker)
    workerApi = wrappedApi

    worker.onerror = event => {
      resetWorker(event.message || 'Item worker failed')
    }

    return wrappedApi
  } catch (error) {
    resetWorker('Failed to initialize item worker', error)
    return null
  }
}

async function withWorkerFallback<T>(
  runWithWorker: (api: Remote<ItemWorkerApi>) => Promise<T>,
  runSynchronously: () => T,
): Promise<T> {
  const api = getWorkerApi()
  if (!api) {
    return runSynchronously()
  }

  try {
    return await runWithWorker(api)
  } catch (error) {
    resetWorker('Item worker execution failed; falling back to synchronous processing', error)
    return runSynchronously()
  }
}

export async function seedAutomergeBinaryWithWorker(items: Item[]): Promise<Array<{ id: string; binary: Uint8Array }>> {
  if (items.length === 0) {
    return []
  }

  return withWorkerFallback(
    async api => api.seedAutomerge(items),
    () => seedAutomergeSynchronously(items),
  )
}
