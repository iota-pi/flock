import { useCallback } from 'react'
import { DEFAULT_CRITERIA } from '../utils/customSort'
import { AccountMetadata as Metadata, MetadataKey } from './metadata'
import { Item, ItemId } from './items'
import { useItemsQuery, useMetadataQuery, useSetMetadataMutation } from '../api/queries'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'

const EMPTY_ARRAY: [] = []
const EMPTY_ITEM_MAP: Record<string, Item> = {}

export const useLoggedIn = () => useAuthStore(state => state.loggedIn)
export const useAuthInitializing = () => useAuthStore(state => state.initializing)

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const loggedIn = useLoggedIn()
  const selectItems = useCallback(
    (items: Item[]) => (
      itemType
        ? items.filter(i => i.type === itemType)
        : items
    ) as T[],
    [itemType],
  )
  const { data: items = EMPTY_ARRAY as T[] } = useItemsQuery<T[]>({ enabled: loggedIn, select: selectItems })
  return items
}

export const useItemMap = () => {
  const loggedIn = useLoggedIn()
  const selectItemMap = useCallback(
    (items: Item[]) => Object.fromEntries(items.map(item => [item.id, item])) as Record<string, Item>,
    [],
  )
  const { data: itemMap = EMPTY_ITEM_MAP } = useItemsQuery<Record<string, Item>>({
    enabled: loggedIn,
    select: selectItemMap,
  })
  return itemMap
}

export const useItem = (id: ItemId) => {
  const loggedIn = useLoggedIn()
  const selectItem = useCallback(
    (items: Item[]) => items.find(item => item.id === id),
    [id],
  )
  const { data: item } = useItemsQuery<Item | undefined>({ enabled: loggedIn, select: selectItem })
  return item
}

export function useItemsById() {
  const itemMap = useItemMap()
  return useCallback(
    <T extends Item>(ids: ItemId[]) => (
      ids.map(id => itemMap[id] as T).filter(item => item !== undefined)
    ),
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
  const loggedIn = useLoggedIn()
  const { data: metadata = {} as Metadata } = useMetadataQuery(loggedIn)
  const { mutateAsync: setMetadata } = useSetMetadataMutation()

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
  const drawers = useUiStore(state => state.drawers)
  return useCallback(
    (itemId: ItemId) => (
      drawers.findIndex(drawer => (
        drawer.open
        && drawer.item === itemId
      )) > -1
    ),
    [drawers],
  )
}

export const usePracticalFilterCount = () => useUiStore(state => (
  state.filters.filter(fc => fc.operator !== 'contains' || fc.value).length
))
