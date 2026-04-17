import { useCallback, useMemo, useRef } from 'react'
import { isEqual } from 'lodash-es'
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

const EMPTY_ARRAY: Item[] = []
const EMPTY_ITEM_MAP: Record<ItemId, Item> = {}
const EMPTY_METADATA = {} as Metadata
const EMPTY_DEFAULT_PRAYER_FREQUENCY = {} as NonNullable<Metadata['defaultPrayerFrequency']>

type SearchItemsResult = {
  defaultFrequencies: NonNullable<Metadata['defaultPrayerFrequency']>,
  items: Item[],
}

type PrayerScheduleInputs = {
  items: Item[],
  prayerGoal: number | undefined,
}

type SearchItemsOptions = {
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

function equalPrayerScheduleInputs(
  left: PrayerScheduleInputs,
  right: PrayerScheduleInputs,
): boolean {
  return (
    left.prayerGoal === right.prayerGoal
    && isEqual(left.items, right.items)
  )
}

function equalSearchItemsResult(
  left: SearchItemsResult,
  right: SearchItemsResult,
): boolean {
  return (
    isEqual(left.defaultFrequencies, right.defaultFrequencies)
    && isEqual(left.items, right.items)
  )
}

function useMemoizedValue<T>(value: T, areEqual: (left: T, right: T) => boolean): T {
  const cacheRef = useRef<{ value: T } | null>(null)

  const cached = cacheRef.current
  if (cached && areEqual(cached.value, value)) {
    return cached.value
  }

  cacheRef.current = { value }
  return value
}

function isVisibleItem(item: Item | null | undefined): item is Item {
  return !!item && !(item as Item & { deleted?: boolean }).deleted
}

export const useLoggedIn = () => useAuthStore(state => state.loggedIn)
export const useAuthReady = () => useAuthStore(state => state.loggedIn && !state.initializing)

export function useAccountMetadata(): Metadata {
  const authReady = useAuthReady()
  const metadata = useAutomergeMetadataSnapshot() as Metadata

  return useMemoizedValue(authReady ? metadata : EMPTY_METADATA, isEqual)
}

function useMetadataValue<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): Metadata[K] {
  const authReady = useAuthReady()
  const metadata = useAutomergeMetadataSnapshot() as Metadata

  const value = authReady
    ? (metadata[key] === undefined ? defaultValue : metadata[key]) as Metadata[K]
    : defaultValue as Metadata[K]

  return useMemoizedValue(value, isEqual)
}

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const authReady = useAuthReady()
  const items = useAutomergeItems()

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

  return useMemoizedValue(nextItems, isEqual)
}

export function useItemsInitialLoading(): boolean {
  return false
}

export const useItemMap = () => {
  const authReady = useAuthReady()
  const items = useAutomergeItems()

  const nextMap = useMemo(
    () => {
      if (!authReady) {
        return EMPTY_ITEM_MAP
      }

      const visibleItems = items.filter(isVisibleItem)
      return Object.fromEntries(visibleItems.map(item => [item.id, item])) as Record<ItemId, Item>
    },
    [authReady, items],
  )

  return useMemoizedValue(nextMap, isEqual)
}

export const useItem = (id: ItemId) => {
  const authReady = useAuthReady()
  const item = useAutomergeItem(id)

  if (!authReady) {
    return undefined
  }

  if (!item || (item as Item & { deleted?: boolean }).deleted) {
    return undefined
  }

  return item
}

export function useItemsById() {
  const itemMap = useItemMap()

  return useCallback(
    <T extends Item>(ids: ItemId[]) => (
      ids.map(id => itemMap[id] as T).filter(item => item !== undefined)
    ) as T[],
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

  return useMemoizedValue(nextItems, isEqual)
}

export function usePrayerScheduleInputs(): PrayerScheduleInputs {
  const authReady = useAuthReady()
  const items = useAutomergeItems()
  const metadata = useAutomergeMetadataSnapshot() as Metadata

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

  return useMemoizedValue(nextValue, equalPrayerScheduleInputs)
}

export function useSearchItems(options: SearchItemsOptions): SearchItemsResult {
  const authReady = useAuthReady()
  const items = useAutomergeItems()
  const metadata = useAutomergeMetadataSnapshot() as Metadata
  const {
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  } = options

  const nextValue = useMemo(
    () => {
      if (!authReady) {
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

  return useMemoizedValue(nextValue, equalSearchItemsResult)
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
  state.filters.filter(fc => fc.operator !== 'contains' || fc.value).length
))
