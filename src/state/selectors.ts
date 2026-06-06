import { useCallback, useMemo, useRef } from 'react'
import deepEqual from 'fast-deep-equal'
import { isPracticalFilterCriterion } from '../utils/customFilter'
import { DEFAULT_CRITERIA, sortItems } from '../utils/customSort'
import type { AccountMetadata as Metadata, MetadataKey } from './metadata'
import type { Item } from './items'
import type { GroupLookupData } from '../shared/itemTypes'
import { setMetadata } from '../features/items/mutations/itemMutations'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'
import { useDataStore } from './dataStore'
import type { GroupItem, ItemId } from 'src/shared/schemas/items'

const EMPTY_ARRAY: Item[] = []
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

export function useVisibleItems(): Item[] {
  const itemsMap = useDataStore(state => state.items)
  const itemIds = useDataStore(state => state.itemIds)

  return useMemo(
    () => itemIds.map(id => itemsMap[id]).filter(isVisibleItem),
    [itemsMap, itemIds],
  )
}

export function useItemsOfType<T extends Item>(itemType?: Item['type']): T[] {
  const visibleItems = useVisibleItems()

  const nextItems = useMemo(
    () => {
      if (!itemType) {
        return visibleItems as T[]
      }

      return visibleItems.filter(item => item.type === itemType) as T[]
    },
    [itemType, visibleItems],
  )

  return useDeepMemo(nextItems)
}

function useMetadataValue<K extends MetadataKey>(
  key: K,
): Metadata[K]
function useMetadataValue<K extends MetadataKey>(
  key: K,
  defaultValue: Exclude<Metadata[K], undefined>,
): Exclude<Metadata[K], undefined>
function useMetadataValue<K extends MetadataKey>(
  key: K,
  defaultValue?: Metadata[K],
): Metadata[K] {
  const value = useDataStore(state => state.metadata[key])

  // Wait for auth before returning real data to prevent flash-of-empty states
  const resolvedValue = value !== undefined
    ? value
    : defaultValue as Metadata[K]

  return useDeepMemo(resolvedValue)
}

export function useItemIds(itemType?: Item['type']): string[] {
  const visibleItems = useVisibleItems()

  const nextIds = useMemo(
    () => {
      const filtered = itemType
        ? visibleItems.filter(item => item.type === itemType)
        : visibleItems

      return filtered.map(item => item.id as string)
    },
    [itemType, visibleItems],
  )

  return useDeepMemo(nextIds)
}

export const useItem = (id: ItemId) => {
  const item = useDataStore(state => state.items[id as string])

  if (!item || item.deleted) {
    return undefined
  }

  return item
}

export function useItemsByIds<T extends Item>(ids: ItemId[]): T[] {
  const itemsMap = useDataStore(state => state.items)

  const nextItems = useMemo(
    () => {
      if (ids.length === 0) {
        return EMPTY_ARRAY as T[]
      }

      return ids.map(id => itemsMap[id as string]).filter(isVisibleItem) as T[]
    },
    [ids, itemsMap],
  )

  return useDeepMemo(nextItems)
}

export function usePrayerScheduleInputs(): PrayerScheduleInputs {
  const visibleItems = useVisibleItems()
  const prayerGoal = useMetadataValue('prayerGoal')

  const nextValue = useMemo(
    () => {
      if (visibleItems.length === 0) {
        return EMPTY_PRAYER_SCHEDULE_INPUTS
      }

      return {
        items: visibleItems,
        prayerGoal,
      }
    },
    [prayerGoal, visibleItems],
  )

  return useDeepMemo(nextValue)
}

export function useSearchItems(options: SearchItemsOptions): Item[] {
  const visibleItems = useVisibleItems()
  const sortCriteria = useMetadataValue('sortCriteria', DEFAULT_CRITERIA)
  const {
    isOpen,
    includeArchived,
    selectedItemIds,
    showSelectedOptions,
    types,
  } = options

  const filteredItems = useMemo(
    () => {
      if (!isOpen) {
        return EMPTY_ARRAY
      }

      const selectedIdSet = new Set(selectedItemIds)

      return visibleItems.filter(item => (
        types[item.type]
        && (includeArchived || !item.archived)
        && (showSelectedOptions || !selectedIdSet.has(item.id))
      ))
    },
    [includeArchived, isOpen, selectedItemIds, showSelectedOptions, types, visibleItems],
  )

  const sortedItems = useMemo(
    () => {
      if (!isOpen) {
        return EMPTY_ARRAY
      }

      return sortItems(filteredItems, sortCriteria)
    },
    [filteredItems, isOpen, sortCriteria],
  )

  return useDeepMemo(sortedItems)
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

export const usePracticalFilterCount = () => useUiStore(state => (
  state.filters.filter(isPracticalFilterCriterion).length
))

export function useGroupLookupMap(): ReadonlyMap<ItemId, GroupLookupData> {
  const groupItems = useItemsOfType<GroupItem>('group')

  return useMemo(
    () => {
      const lookup = new Map<ItemId, GroupLookupData>()

      for (const item of groupItems) {
        if (item.archived) {
          continue
        }

        const group = item as GroupItem
        const members = Array.isArray(group.members) ? group.members : []

        for (const memberId of members) {
          const existing = lookup.get(memberId as ItemId)
          if (existing) {
            existing.groupNames.push(group.name || '')
            existing.groupIds.push(group.id as ItemId)
          } else {
            lookup.set(memberId as ItemId, {
              groupNames: [group.name || ''],
              groupIds: [group.id as ItemId],
            })
          }
        }
      }
      return lookup
    },
    [groupItems],
  )
}
