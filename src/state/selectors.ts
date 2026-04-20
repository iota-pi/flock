import { useCallback, useMemo, useState } from 'react'
import { isPracticalFilterCriterion } from '../utils/customFilter'
import { DEFAULT_CRITERIA, sortItems } from '../utils/customSort'
import type { AccountMetadata as Metadata, MetadataKey } from './metadata'
import type { Item } from './items'
import type { ItemId } from '../shared/itemTypes'
import { setMetadata } from '../features/items/mutations/itemMutations'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'
import { useNavigationStore } from './navigationStore'
import {
  useAutomergeItem,
  useAutomergeItems,
  useAutomergeMetadataSnapshot,
} from '../sync/useAutomerge'
import { stableSerialize } from 'src/sync/syncUtils'

const EMPTY_ARRAY: Item[] = []
const EMPTY_ITEM_MAP: Record<ItemId, Item> = {}
const EMPTY_METADATA: Metadata = {}
const EMPTY_DEFAULT_PRAYER_FREQUENCY: NonNullable<Metadata['defaultPrayerFrequency']> = {}

type SearchItemsResult = {
  defaultFrequencies: NonNullable<Metadata['defaultPrayerFrequency']>,
  items: Item[],
}

type PrayerScheduleInputs = {
  items: Item[],
  prayerGoal: number | undefined,
}

type SearchItemsOptions = {
  isOpen: boolean,
  includeArchived: boolean,
  selectedItemIds: ItemId[],
  showSelectedOptions: boolean,
  types: Readonly<Partial<Record<Item['type'], boolean>>>,
}

const EMPTY_PRAYER_SCHEDULE_INPUTS: PrayerScheduleInputs = {
  items: EMPTY_ARRAY,
  prayerGoal: undefined,
}

const EMPTY_SEARCH_ITEMS_RESULT: SearchItemsResult = {
  defaultFrequencies: EMPTY_DEFAULT_PRAYER_FREQUENCY,
  items: EMPTY_ARRAY,
}

function useMemoizedValue<T>(value: T): T {
  const signature = useMemo(
    () => stableSerialize(value),
    [value],
  )

  const [cache] = useState(() => new Map<string, T>())

  if (!cache.has(signature)) {
    if (cache.size > 50) {
      cache.clear()
    }

    cache.set(signature, value)
  }

  return cache.get(signature) as T
}

function isVisibleItem(item: Item | null | undefined): item is Item {
  return !!item && !item.deleted
}

export const useLoggedIn = () => useAuthStore(state => state.loggedIn)
export const useAuthReady = () => useAuthStore(state => state.loggedIn && !state.initializing)

export function useAccountMetadata(): Metadata {
  const authReady = useAuthReady()
  const metadata = useAutomergeMetadataSnapshot()

  return useMemoizedValue(authReady ? metadata : EMPTY_METADATA)
}

function useMetadataValue<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): Metadata[K] {
  const authReady = useAuthReady()
  const metadata = useAutomergeMetadataSnapshot()

  const value = authReady
    ? (metadata[key] === undefined ? defaultValue : metadata[key]) as Metadata[K]
    : defaultValue as Metadata[K]

  return useMemoizedValue(value)
}

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const authReady = useAuthReady()
  const items = useAutomergeItems<Item>()

  const nextItems = useMemo(
    () => {
      if (!authReady) {
        return EMPTY_ARRAY as T[]
      }

      const visibleItems = items.filter(isVisibleItem)
      return (
        itemType
          ? visibleItems.filter(item => item.type === itemType)
          : visibleItems
      ) as T[]
    },
    [authReady, itemType, items],
  )

  return useMemoizedValue(nextItems)
}

export const useItemMap = () => {
  const authReady = useAuthReady()
  const items = useAutomergeItems<Item>()

  const nextMap = useMemo(
    () => {
      if (!authReady) {
        return EMPTY_ITEM_MAP
      }

      const visibleItems = items.filter(isVisibleItem)
      return visibleItems.reduce<Record<ItemId, Item>>((result, item) => {
        result[item.id] = item
        return result
      }, {})
    },
    [authReady, items],
  )

  return useMemoizedValue(nextMap)
}

export const useItem = (id: ItemId) => {
  const authReady = useAuthReady()
  const item = useAutomergeItem<Item>(id)

  if (!authReady) {
    return undefined
  }

  if (!item || item.deleted) {
    return undefined
  }

  return item
}

export function useItemsById() {
  const itemMap = useItemMap()

  return useCallback(
    <T extends Item>(ids: ItemId[]) => ids
      .map(id => itemMap[id])
      .filter((item): item is T => item !== undefined),
    [itemMap],
  )
}

export function useItemsByIds<T extends Item>(ids: ItemId[]): T[] {
  const authReady = useAuthReady()
  const itemMap = useItemMap()

  const nextItems = useMemo(
    () => {
      if (!authReady || ids.length === 0) {
        return EMPTY_ARRAY as T[]
      }

      return ids
        .map(itemId => itemMap[itemId])
        .filter(isVisibleItem) as T[]
    },
    [authReady, ids, itemMap],
  )

  return useMemoizedValue(nextItems)
}

export function usePrayerScheduleInputs(): PrayerScheduleInputs {
  const authReady = useAuthReady()
  const items = useAutomergeItems<Item>()
  const metadata = useAutomergeMetadataSnapshot()

  const nextValue = useMemo(
    () => {
      if (!authReady) {
        return EMPTY_PRAYER_SCHEDULE_INPUTS
      }

      return {
        items: items.filter(isVisibleItem),
        prayerGoal: metadata.prayerGoal,
      }
    },
    [authReady, items, metadata],
  )

  return useMemoizedValue(nextValue)
}

export function useSearchItems(options: SearchItemsOptions): SearchItemsResult {
  const authReady = useAuthReady()
  const items = useAutomergeItems<Item>()
  const metadata = useAutomergeMetadataSnapshot()
  const {
    isOpen,
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  } = options

  const nextValue = useMemo(
    () => {
      if (!authReady || !isOpen) {
        return EMPTY_SEARCH_ITEMS_RESULT
      }

      const sortCriteria = metadata.sortCriteria || DEFAULT_CRITERIA
      const defaultFrequencies = metadata.defaultPrayerFrequency || EMPTY_DEFAULT_PRAYER_FREQUENCY
      const selectedIdSet = new Set(selectedItemIds)

      const visibleItems = items.filter(isVisibleItem)
      const nextItems = sortItems(
        visibleItems.filter(item => (
          types[item.type]
          && (includeArchived || !item.archived)
          && (showSelectedOptions || !selectedIdSet.has(item.id))
        )),
        sortCriteria,
      )

      return {
        defaultFrequencies,
        items: nextItems,
      }
    },
    [authReady, includeArchived, items, metadata, selectedItemIds, showSelectedOptions, types],
  )

  return useMemoizedValue(nextValue)
}

export function useMetadata<K extends MetadataKey>(
  key: K,
  defaultValue: Metadata[K],
): ([
  Exclude<Metadata[K], undefined>,
  (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>,
])
export function useMetadata<K extends MetadataKey>(
  key: K,
): [Metadata[K], (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>]
export function useMetadata<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): [Metadata[K], (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>] {
  const value = useMetadataValue(key, defaultValue)
  const setValue = useCallback(
    async (newValueOrFunc: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => {
      await setMetadata(previousMetadata => {
        const previousValue = previousMetadata[key] === undefined
          ? defaultValue
          : previousMetadata[key]
        const newValue = typeof newValueOrFunc === 'function'
          ? (newValueOrFunc as (prev: Metadata[K]) => Metadata[K])(previousValue as Metadata[K])
          : newValueOrFunc

        return {
          ...previousMetadata,
          [key]: newValue,
        } as Metadata
      })
    },
    [defaultValue, key],
  )

  return [value, setValue]
}

export const useSortCriteria = () => useMetadata('sortCriteria', DEFAULT_CRITERIA)

export const useIsActive = () => {
  const drawers = useNavigationStore(state => state.drawers)
  return useCallback(
    (itemId: ItemId) => (
      drawers.findIndex(drawer => (
        drawer.item === itemId
      )) > -1
    ),
    [drawers],
  )
}

export const usePracticalFilterCount = () => useUiStore(state => (
  state.filters.filter(isPracticalFilterCriterion).length
))
