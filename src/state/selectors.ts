import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
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
  getAutomergeItem,
  getAutomergeItems,
  getAutomergeMetadata,
  subscribeAutomergeSnapshots,
} from '../sync/automergeDocStore'
import { useAutomergeItem, useAutomergeItems, useAutomergeMetadataSnapshot } from '../sync/useAutomerge'

const EMPTY_ARRAY: Item[] = []
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

function useAutomergeItemsSnapshot(): Item[] {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const itemsSnapshot = useAutomergeItems()

  return authReady ? itemsSnapshot : EMPTY_ARRAY
}

function shallowEqual<T>(left: T[], right: T[]): boolean {
  if (left === right) {
    return true
  }

  if (left.length !== right.length) {
    return false
  }

  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false
    }
  }

  return true
}

function shallowEqualRecord<T extends string, U>(
  left: Partial<Record<T, U>>,
  right: Partial<Record<T, U>>,
): boolean {
  if (left === right) {
    return true
  }

  const leftKeys = Object.keys(left) as T[]
  const rightKeys = Object.keys(right) as T[]

  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false
    }
  }

  return true
}

function isVisibleItem(item: Item | null): item is Item {
  return !!item && !(item as Item & { deleted?: boolean }).deleted
}

export const useLoggedIn = () => useAuthStore(state => state.loggedIn)
export const useAuthReady = () => useAuthStore(state => state.loggedIn && !state.initializing)

export function useAccountMetadata(): Metadata {
  const authReady = useAuthReady()
  const metadata = useAutomergeMetadataSnapshot()

  return authReady ? metadata as Metadata : EMPTY_METADATA
}

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const items = useAutomergeItemsSnapshot()

  return useMemo(() => {
    const visibleItems = items.filter(item => !(item as Item & { deleted?: boolean }).deleted)
    return (
      itemType
        ? visibleItems.filter(i => i.type === itemType)
        : visibleItems
    ) as T[]
  }, [itemType, items])
}

export function useItemsInitialLoading(): boolean {
  return false
}

export const useItemMap = () => {
  const items = useAutomergeItemsSnapshot()

  return useMemo(() => {
    const visibleItems = items.filter(item => !(item as Item & { deleted?: boolean }).deleted)
    return Object.fromEntries(visibleItems.map(item => [item.id, item])) as Record<ItemId, Item>
  }, [items])
}

export const useItem = (id: ItemId) => {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
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
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const cacheRef = useRef<{ ids: ItemId[], items: Item[] } | null>(null)

  const getSnapshot = useCallback(
    () => {
      if (!authReady || ids.length === 0) {
        const cached = cacheRef.current
        if (
          cached
          && cached.items.length === 0
          && shallowEqual(cached.ids, ids)
        ) {
          return cached.items as T[]
        }

        cacheRef.current = {
          ids: [...ids],
          items: EMPTY_ARRAY,
        }
        return EMPTY_ARRAY as T[]
      }

      const nextItems = ids
        .map(itemId => getAutomergeItem(itemId))
        .filter(isVisibleItem)

      const cached = cacheRef.current
      if (
        cached
        && shallowEqual(cached.ids, ids)
        && shallowEqual(cached.items, nextItems)
      ) {
        return cached.items as T[]
      }

      cacheRef.current = {
        ids: [...ids],
        items: nextItems,
      }

      return nextItems as T[]
    },
    [authReady, ids],
  )

  const getServerSnapshot = useCallback(() => EMPTY_ARRAY as T[], [])

  return useSyncExternalStore(subscribeAutomergeSnapshots, getSnapshot, getServerSnapshot)
}

export function usePrayerScheduleInputs(): PrayerScheduleInputs {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const cacheRef = useRef<PrayerScheduleInputs | null>(null)

  const getSnapshot = useCallback(
    () => {
      if (!authReady) {
        const cached = cacheRef.current
        if (cached && cached.items.length === 0 && cached.prayerGoal === undefined) {
          return cached
        }

        cacheRef.current = EMPTY_PRAYER_SCHEDULE_INPUTS
        return EMPTY_PRAYER_SCHEDULE_INPUTS
      }

      const metadata = getAutomergeMetadata() as Metadata
      const prayerGoal = metadata.prayerGoal
      const nextItems = getAutomergeItems().filter(item => !(item as Item & { deleted?: boolean }).deleted)

      const cached = cacheRef.current
      if (
        cached
        && cached.prayerGoal === prayerGoal
        && isEqual(cached.items, nextItems)
      ) {
        return cached
      }

      const next: PrayerScheduleInputs = {
        items: nextItems,
        prayerGoal,
      }

      cacheRef.current = next
      return next
    },
    [authReady],
  )

  const getServerSnapshot = useCallback(() => EMPTY_PRAYER_SCHEDULE_INPUTS, [])

  return useSyncExternalStore(subscribeAutomergeSnapshots, getSnapshot, getServerSnapshot)
}

export function useSearchItems(options: SearchItemsOptions): SearchItemsResult {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const cacheRef = useRef<SearchItemsResult | null>(null)
  const {
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  } = options

  const getSnapshot = useCallback(
    () => {
      if (!authReady) {
        const cached = cacheRef.current
        if (cached && cached.items.length === 0 && shallowEqualRecord(cached.defaultFrequencies, EMPTY_DEFAULT_PRAYER_FREQUENCY)) {
          return cached
        }

        const emptyResult: SearchItemsResult = {
          defaultFrequencies: EMPTY_DEFAULT_PRAYER_FREQUENCY,
          items: EMPTY_ARRAY,
        }
        cacheRef.current = emptyResult
        return emptyResult
      }

      const metadata = getAutomergeMetadata() as Metadata
      const sortCriteria = metadata.sortCriteria || DEFAULT_CRITERIA
      const defaultFrequencies = metadata.defaultPrayerFrequency || EMPTY_DEFAULT_PRAYER_FREQUENCY
      const selectedIdSet = new Set(selectedItemIds)

      const visibleItems = getAutomergeItems().filter(item => !(item as Item & { deleted?: boolean }).deleted)
      const nextItems = sortItems(
        visibleItems.filter(item => (
          types[item.type]
          && (includeArchived || !item.archived)
          && (showSelectedOptions || !selectedIdSet.has(item.id))
        )),
        sortCriteria,
      )

      const cached = cacheRef.current
      if (
        cached
        && isEqual(cached.items, nextItems)
        && shallowEqualRecord(cached.defaultFrequencies, defaultFrequencies)
      ) {
        return cached
      }

      const next: SearchItemsResult = {
        defaultFrequencies,
        items: nextItems,
      }

      cacheRef.current = next
      return next
    },
    [authReady, includeArchived, selectedItemIds, showSelectedOptions, types],
  )

  const getServerSnapshot = useCallback((): SearchItemsResult => ({
    defaultFrequencies: EMPTY_DEFAULT_PRAYER_FREQUENCY,
    items: EMPTY_ARRAY,
  }), [])

  return useSyncExternalStore(subscribeAutomergeSnapshots, getSnapshot, getServerSnapshot)
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
  const metadata = useAccountMetadata()

  const value = metadata[key] === undefined ? defaultValue : metadata[key]
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
