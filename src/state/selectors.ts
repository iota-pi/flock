import { useCallback, useMemo } from 'react'
import { DEFAULT_CRITERIA } from '../utils/customSort'
import type { AccountMetadata as Metadata, MetadataKey } from './metadata'
import type { Item } from './items'
import type { ItemId } from '../shared/itemTypes'
import { setMetadata } from '../features/items/mutations/itemMutations'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'
import { useNavigationStore } from './navigationStore'
import { useAutomergeItem, useAutomergeItems, useAutomergeMetadataSnapshot } from '../sync/useAutomerge'

const EMPTY_ARRAY: Item[] = []
const EMPTY_ITEM_MAP: Record<ItemId, Item> = {}
const EMPTY_METADATA = {} as Metadata

function useAutomergeItemsSnapshot(): Item[] {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const itemsSnapshot = useAutomergeItems()

  return authReady ? itemsSnapshot : EMPTY_ARRAY
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
