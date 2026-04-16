import { useCallback, useRef, useSyncExternalStore } from 'react'
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
import { useAutomergeItem, useAutomergeMetadataSnapshot } from '../sync/useAutomerge'

const EMPTY_ARRAY: Item[] = []
const EMPTY_ITEM_MAP: Record<ItemId, Item> = {}
const EMPTY_METADATA = {} as Metadata
const EMPTY_DEFAULT_PRAYER_FREQUENCY = {} as NonNullable<Metadata['defaultPrayerFrequency']>

type SearchItemsResult = {
  defaultFrequencies: NonNullable<Metadata['defaultPrayerFrequency']>,
  items: Item[],
}

type MemoizedSelectorOptions<T> = {
  authReady: boolean,
  areEqual: (left: T, right: T) => boolean,
  emptyValue: T,
  selectWhenReady: () => T,
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

function useMemoizedSelector<T>({
  authReady,
  areEqual,
  emptyValue,
  selectWhenReady,
}: MemoizedSelectorOptions<T>): T {
  const cacheRef = useRef<{ value: T } | null>(null)

  const getSnapshot = useCallback(
    () => {
      const nextValue = authReady
        ? selectWhenReady()
        : emptyValue

      const cached = cacheRef.current
      if (cached && areEqual(cached.value, nextValue)) {
        return cached.value
      }

      cacheRef.current = { value: nextValue }
      return nextValue
    },
    [areEqual, authReady, emptyValue, selectWhenReady],
  )

  const getServerSnapshot = useCallback(() => emptyValue, [emptyValue])

  return useSyncExternalStore(subscribeAutomergeSnapshots, getSnapshot, getServerSnapshot)
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

function useMetadataValue<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): Metadata[K] {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)

  const selectWhenReady = useCallback(
    () => {
      const metadata = getAutomergeMetadata() as Metadata
      return (metadata[key] === undefined ? defaultValue : metadata[key]) as Metadata[K]
    },
    [defaultValue, key],
  )

  return useMemoizedSelector<Metadata[K]>({
    authReady,
    areEqual: isEqual,
    emptyValue: defaultValue as Metadata[K],
    selectWhenReady,
  })
}

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const selectWhenReady = useCallback(
    () => {
      const visibleItems = getAutomergeItems().filter(item => !(item as Item & { deleted?: boolean }).deleted)
      return (
        itemType
          ? visibleItems.filter(item => item.type === itemType)
          : visibleItems
      ) as T[]
    },
    [itemType],
  )

  return useMemoizedSelector<T[]>({
    authReady,
    areEqual: isEqual,
    emptyValue: EMPTY_ARRAY as T[],
    selectWhenReady,
  })
}

export function useItemsInitialLoading(): boolean {
  return false
}

export const useItemMap = () => {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const selectWhenReady = useCallback(
    () => {
      const visibleItems = getAutomergeItems().filter(item => !(item as Item & { deleted?: boolean }).deleted)
      return Object.fromEntries(visibleItems.map(item => [item.id, item])) as Record<ItemId, Item>
    },
    [],
  )

  return useMemoizedSelector<Record<ItemId, Item>>({
    authReady,
    areEqual: isEqual,
    emptyValue: EMPTY_ITEM_MAP,
    selectWhenReady,
  })
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
  const selectWhenReady = useCallback(
    () => {
      if (ids.length === 0) {
        return EMPTY_ARRAY as T[]
      }

      return ids
        .map(itemId => getAutomergeItem(itemId))
        .filter(isVisibleItem) as T[]
    },
    [ids],
  )

  return useMemoizedSelector<T[]>({
    authReady,
    areEqual: isEqual,
    emptyValue: EMPTY_ARRAY as T[],
    selectWhenReady,
  })
}

export function usePrayerScheduleInputs(): PrayerScheduleInputs {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const selectWhenReady = useCallback(
    () => {
      const metadata = getAutomergeMetadata() as Metadata
      return {
        items: getAutomergeItems().filter(item => !(item as Item & { deleted?: boolean }).deleted),
        prayerGoal: metadata.prayerGoal,
      }
    },
    [],
  )

  return useMemoizedSelector<PrayerScheduleInputs>({
    authReady,
    areEqual: equalPrayerScheduleInputs,
    emptyValue: EMPTY_PRAYER_SCHEDULE_INPUTS,
    selectWhenReady,
  })
}

export function useSearchItems(options: SearchItemsOptions): SearchItemsResult {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const {
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  } = options

  const selectWhenReady = useCallback(
    () => {
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

      return {
        defaultFrequencies,
        items: nextItems,
      }
    },
    [includeArchived, selectedItemIds, showSelectedOptions, types],
  )

  return useMemoizedSelector<SearchItemsResult>({
    authReady,
    areEqual: equalSearchItemsResult,
    emptyValue: EMPTY_SEARCH_ITEMS_RESULT,
    selectWhenReady,
  })
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
