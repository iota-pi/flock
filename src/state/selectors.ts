import { useCallback, useMemo, useRef } from 'react'
import deepEqual from 'fast-deep-equal'
import { isPracticalFilterCriterion } from '../utils/customFilter'
import { DEFAULT_CRITERIA, sortItems } from '../utils/customSort'
import type { AccountMetadata as Metadata, MetadataKey } from './metadata'
import type { Item } from './items'
import type { ItemId } from '../shared/itemTypes'
import { setMetadata } from '../features/items/mutations/itemMutations'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'
import { useNavigationStore } from './navigationStore'
import { useDataStore } from './dataStore'
import { GroupItem } from 'src/shared/schemas/items'

const EMPTY_ARRAY: Item[] = []
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

/* eslint-disable react-hooks/refs */
function useDeepMemo<T>(value: T): T {
  const ref = useRef<T>(value)

  if (!deepEqual(ref.current, value)) {
    ref.current = value
  }

  return ref.current
}

function isVisibleItem(item: Item | null | undefined): item is Item {
  return !!item && !item.deleted
}

export const useLoggedIn = () => useAuthStore(state => state.loggedIn)
export const useAuthReady = () => useAuthStore(state => state.loggedIn && !state.initializing)

export function useVisibleItems(): Item[] {
  const authReady = useAuthReady()
  const itemsMap = useDataStore(state => state.items)
  const itemIds = useDataStore(state => state.itemIds)

  return useMemo(
    () => {
      if (!authReady) {
        return EMPTY_ARRAY
      }

      return itemIds.map(id => itemsMap[id]).filter(isVisibleItem)
    },
    [authReady, itemsMap, itemIds],
  )
}

export function useVisibleItemIds(): string[] {
  const authReady = useAuthReady()
  const itemIds = useDataStore(state => state.itemIds)

  return useMemo(
    () => {
      if (!authReady) {
        return []
      }

      return itemIds
    },
    [authReady, itemIds],
  )
}

export function useMetadataValue<K extends MetadataKey>(
  key: K,
): Metadata[K]
export function useMetadataValue<K extends MetadataKey>(
  key: K,
  defaultValue: Exclude<Metadata[K], undefined>,
): Exclude<Metadata[K], undefined>
export function useMetadataValue<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): Metadata[K] {
  const authReady = useAuthReady()
  const value = useDataStore(state => state.metadata[key])

  // Wait for auth before returning real data to prevent flash-of-empty states
  const resolvedValue = authReady && value !== undefined
    ? value
    : defaultValue as Metadata[K]

  return useDeepMemo(resolvedValue)
}

export function useItemIds(itemType?: Item['type']): string[] {
  const authReady = useAuthReady()
  const visibleItems = useVisibleItems()

  const nextIds = useMemo(
    () => {
      if (!authReady) {
        return []
      }

      const filtered = itemType
        ? visibleItems.filter(item => isVisibleItem(item) && item.type === itemType)
        : visibleItems.filter(isVisibleItem)

      return filtered.map(item => item.id as string)
    },
    [authReady, itemType, visibleItems],
  )

  return useDeepMemo(nextIds)
}

export const useItem = (id: ItemId) => {
  const authReady = useAuthReady()
  const item = useDataStore(state => state.items[id as string])

  if (!authReady) {
    return undefined
  }

  if (!item || item.deleted) {
    return undefined
  }

  return item
}

export function useItemsByIds<T extends Item>(ids: ItemId[]): T[] {
  const authReady = useAuthReady()
  const itemsMap = useDataStore(state => state.items)

  const nextItems = useMemo(
    () => {
      if (!authReady || ids.length === 0) {
        return EMPTY_ARRAY as T[]
      }

      return ids.map(id => itemsMap[id as string]).filter(isVisibleItem) as T[]
    },
    [authReady, ids, itemsMap],
  )

  return useDeepMemo(nextItems)
}

export function usePrayerScheduleInputs(): PrayerScheduleInputs {
  const authReady = useAuthReady()
  const visibleItems = useVisibleItems()
  const prayerGoal = useMetadataValue('prayerGoal')

  const nextValue = useMemo(
    () => {
      if (!authReady) {
        return EMPTY_PRAYER_SCHEDULE_INPUTS
      }

      return {
        items: visibleItems,
        prayerGoal,
      }
    },
    [authReady, prayerGoal, visibleItems],
  )

  return useDeepMemo(nextValue)
}

export function useSearchItems(options: SearchItemsOptions): SearchItemsResult {
  const authReady = useAuthReady()
  const visibleItems = useVisibleItems()
  const sortCriteria = useMetadataValue('sortCriteria', DEFAULT_CRITERIA)
  const defaultPrayerFrequency = useMetadataValue('defaultPrayerFrequency', EMPTY_DEFAULT_PRAYER_FREQUENCY)
  const {
    isOpen,
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  } = options

  const filteredItems = useMemo(
    () => {
      if (!authReady || !isOpen) {
        return EMPTY_ARRAY
      }

      const selectedIdSet = new Set(selectedItemIds)

      return visibleItems.filter(item => (
        types[item.type]
        && (includeArchived || !item.archived)
        && (showSelectedOptions || !selectedIdSet.has(item.id))
      ))
    },
    [authReady, includeArchived, isOpen, selectedItemIds, showSelectedOptions, types, visibleItems],
  )

  const sortedItems = useMemo(
    () => {
      if (!authReady || !isOpen) {
        return EMPTY_ARRAY
      }

      return sortItems(filteredItems, sortCriteria)
    },
    [authReady, filteredItems, isOpen, sortCriteria],
  )

  const nextValue = useMemo(
    () => {
      if (!authReady || !isOpen) {
        return EMPTY_SEARCH_ITEMS_RESULT
      }

      return {
        defaultFrequencies: defaultPrayerFrequency,
        items: sortedItems,
      }
    },
    [authReady, isOpen, defaultPrayerFrequency, sortedItems],
  )

  return useDeepMemo(nextValue)
}

type SetMetadata<K extends MetadataKey> = (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>

export function useMetadata<K extends MetadataKey>(
  key: K,
  defaultValue: Exclude<Metadata[K], undefined>,
): [
  Exclude<Metadata[K], undefined>,
  SetMetadata<K>,
]
export function useMetadata<K extends MetadataKey>(
  key: K,
): [
  Metadata[K],
  SetMetadata<K>,
]
export function useMetadata<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): [
  Metadata[K],
  SetMetadata<K>,
] {
  // Workaround type inference quirks with overloads
  const defaultedValue = defaultValue as Exclude<Metadata[K], undefined>
  const value = useMetadataValue(key, defaultedValue)
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
  const activeDrawer = useNavigationStore(state => state.drawer)
  return useCallback(
    (itemId: ItemId) => activeDrawer?.item === itemId,
    [activeDrawer],
  )
}

export const usePracticalFilterCount = () => useUiStore(state => (
  state.filters.filter(isPracticalFilterCriterion).length
))

export interface GroupLookupData {
  tags: string[]
  groupIds: ItemId[]
}

export function useGroupLookupMap(): ReadonlyMap<ItemId, GroupLookupData> {
  const visibleItems = useVisibleItems()

  return useMemo(
    () => {
      const lookup = new Map<ItemId, GroupLookupData>()

      for (const item of visibleItems) {
        if (item.type !== 'group' || item.archived) {
          continue
        }

        const group = item as GroupItem
        const members = Array.isArray(group.members) ? group.members : []

        for (const memberId of members) {
          const existing = lookup.get(memberId as ItemId)
          if (existing) {
            existing.tags.push(group.name || '')
            existing.groupIds.push(group.id as ItemId)
          } else {
            lookup.set(memberId as ItemId, {
              tags: [group.name || ''],
              groupIds: [group.id as ItemId],
            })
          }
        }
      }
      return lookup
    },
    [visibleItems],
  )
}
