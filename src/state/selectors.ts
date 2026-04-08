import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DEFAULT_CRITERIA } from '../utils/customSort'
import type { AccountMetadata as Metadata, MetadataKey } from './metadata'
import type { Item } from './items'
import type { ItemId } from '../shared/itemTypes'
import {
  ensureItemsBootstrap,
  fetchMetadata,
  metadataQueryOptions,
} from '../api/itemReadService'
import { mutateSetMetadata } from '../api/itemMutations'
import { queryClient } from '../api/queryClient'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from '../api/trpc'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'
import { useNavigationStore } from './navigationStore'
import { getAutomergeItems, subscribeAutomergeItems } from '../sync/automergeDocStore'

const EMPTY_ARRAY: Item[] = []
const EMPTY_ITEM_MAP: Record<ItemId, Item> = {}

function useAutomergeItemsSnapshot(): Item[] {
  const authReady = useAuthStore(state => state.loggedIn && !state.initializing)
  const account = useAuthStore(state => state.account)

  useEffect(() => {
    if (!authReady || !account) {
      return
    }

    void ensureItemsBootstrap(account).catch(() => undefined)
  }, [account, authReady])

  return useSyncExternalStore(
    subscribeAutomergeItems,
    () => (authReady ? getAutomergeItems() : EMPTY_ARRAY),
    () => EMPTY_ARRAY,
  )
}

export const useLoggedIn = () => useAuthStore(state => state.loggedIn)
export const useAuthReady = () => useAuthStore(state => state.loggedIn && !state.initializing)

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
    if (items.length === 0) {
      return EMPTY_ITEM_MAP
    }

    const visibleItems = items.filter(item => !(item as Item & { deleted?: boolean }).deleted)
    return Object.fromEntries(visibleItems.map(item => [item.id, item])) as Record<ItemId, Item>
  }, [items])
}

export const useItem = (id: ItemId) => {
  const items = useAutomergeItemsSnapshot()

  return useMemo(
    () => items
      .filter(item => !(item as Item & { deleted?: boolean }).deleted)
      .find(item => item.id === id),
    [id, items],
  )
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
    ...metadataQueryOptions,
  })

  const value = metadata[key] === undefined ? defaultValue : metadata[key]
  const setValue = useCallback(
    async (newValueOrFunc: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => {
      const latestMetadata = queryClient.getQueryData<Metadata>(getQueryKey(trpc.accounts.getMetadata))
      const baseMetadata = latestMetadata ?? metadata ?? {} as Metadata
      const previousValue = baseMetadata[key] === undefined ? defaultValue : baseMetadata[key]
      const newValue = typeof newValueOrFunc === 'function'
        ? (newValueOrFunc as (prev: Metadata[K]) => Metadata[K])(previousValue as Metadata[K])
        : newValueOrFunc

      await mutateSetMetadata({ ...baseMetadata, [key]: newValue } as Metadata)
    },
    [defaultValue, key, metadata],
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
