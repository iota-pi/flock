import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DEFAULT_CRITERIA } from '../utils/customSort'
import type { AccountMetadata as Metadata, MetadataKey } from './metadata'
import type { Item } from './items'
import type { ItemId } from '../shared/itemTypes'
import { fetchItems, fetchMetadata } from '../api/itemReadService'
import { mutateSetMetadata } from '../api/itemMutations'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from '../api/trpc'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'
import { useNavigationStore } from './navigationStore'

const EMPTY_ARRAY: [] = []
const EMPTY_ITEM_MAP: Record<ItemId, Item> = {}

export const useLoggedIn = () => useAuthStore(state => state.loggedIn)
export const useAuthReady = () => useAuthStore(state => state.loggedIn && !state.initializing)

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const authReady = useAuthReady()
  const selectItems = useCallback(
    (items: Item[]) => {
      const visibleItems = items.filter(item => !(item as Item & { deleted?: boolean }).deleted)
      return (
        itemType
          ? visibleItems.filter(i => i.type === itemType)
          : visibleItems
      ) as T[]
    },
    [itemType],
  )
  const { data: items = EMPTY_ARRAY as T[] } = useQuery<Item[], Error, T[]>({
    queryKey: getQueryKey(trpc.items.fetchMany),
    queryFn: fetchItems,
    enabled: authReady,
    select: selectItems,
  })
  return items
}

export function useItemsInitialLoading(): boolean {
  const authReady = useAuthReady()
  const { isLoading } = useQuery<Item[]>({
    queryKey: getQueryKey(trpc.items.fetchMany),
    queryFn: fetchItems,
    enabled: authReady,
  })
  return isLoading
}

export const useItemMap = () => {
  const authReady = useAuthReady()
  const selectItemMap = useCallback(
    (items: Item[]) => {
      const visibleItems = items.filter(item => !(item as Item & { deleted?: boolean }).deleted)
      return Object.fromEntries(visibleItems.map(item => [item.id, item])) as Record<ItemId, Item>
    },
    [],
  )
  const { data: itemMap = EMPTY_ITEM_MAP } = useQuery<Item[], Error, Record<ItemId, Item>>({
    queryKey: getQueryKey(trpc.items.fetchMany),
    queryFn: fetchItems,
    enabled: authReady,
    select: selectItemMap,
  })
  return itemMap
}

export const useItem = (id: ItemId) => {
  const authReady = useAuthReady()
  const selectItem = useCallback(
    (items: Item[]) => items
      .filter(item => !(item as Item & { deleted?: boolean }).deleted)
      .find(item => item.id === id),
    [id],
  )
  const { data: item } = useQuery<Item[], Error, Item | undefined>({
    queryKey: getQueryKey(trpc.items.fetchMany),
    queryFn: fetchItems,
    enabled: authReady      && typeof id === 'string',
    select: selectItem,
  })
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
  const authReady = useAuthReady()
  const { data: metadata = {} as Metadata } = useQuery({
    queryKey: getQueryKey(trpc.accounts.getMetadata),
    queryFn: fetchMetadata,
    enabled: authReady,
  })
  const setMetadata = mutateSetMetadata

  const value = metadata[key] === undefined ? defaultValue : metadata[key]
  const setValue = useCallback(
    async (newValueOrFunc: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => {
      await setMetadata(prevMetadata => {
        const baseMetadata = prevMetadata ?? {} as Metadata
        const previousValue = baseMetadata[key] === undefined ? defaultValue : baseMetadata[key]
        const newValue = typeof newValueOrFunc === 'function'
          ? (newValueOrFunc as (prev: Metadata[K]) => Metadata[K])(previousValue as Metadata[K])
          : newValueOrFunc
        return { ...baseMetadata, [key]: newValue } as Metadata
      })
    },
    [defaultValue, key, setMetadata],
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
