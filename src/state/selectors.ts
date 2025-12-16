import { Dispatch, SetStateAction, useCallback, useMemo } from 'react'
import { useAppDispatch, useAppSelector } from '../store'
import { DEFAULT_CRITERIA } from '../utils/customSort'
import { AccountMetadata as Metadata, MetadataKey } from './account'
import { Item, ItemId } from './items'
import { setUi, UiOptions } from './ui'
import { useItemsQuery, useMetadataQuery, useSetMetadataMutation } from '../api/queries'

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const loggedIn = useLoggedIn()
  const { data: items = [] } = useItemsQuery(loggedIn)
  return useMemo(
    () => (
      itemType
        ? items.filter(i => i.type === itemType)
        : items
    ) as T[],
    [items, itemType],
  )
}

export const useItemMap = () => {
  const loggedIn = useLoggedIn()
  const { data: items = [] } = useItemsQuery(loggedIn)
  return useMemo(() => Object.fromEntries(items.map(item => [item.id, item])), [items])
}

export const useItem = (id: ItemId) => {
  const loggedIn = useLoggedIn()
  const { data: items = [] } = useItemsQuery(loggedIn)
  return useMemo(() => items.find(item => item.id === id), [items, id])
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

export const useLoggedIn = () => useAppSelector(state => state.account.loggedIn)

export function useMetadata<K extends MetadataKey>(
  key: K,
  defaultValue: Metadata[K],
): [
  Exclude<Metadata[K], undefined>,
  (value: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => Promise<void>,
]
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
  const drawers = useAppSelector(state => state.ui.drawers)
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

export const usePracticalFilterCount = () => useAppSelector(state => (
  state.ui.filters.filter(fc => fc.operator !== 'contains' || fc.value).length
))

export const useOptions = () => useAppSelector(state => state.ui.options)
export function useOption<T extends keyof UiOptions>(
  optionKey: T,
): [UiOptions[T], Dispatch<SetStateAction<UiOptions[T]>>] {
  const option = useOptions()[optionKey]

  const dispatch = useAppDispatch()
  const setOption: Dispatch<SetStateAction<UiOptions[T]>> = useCallback(
    valueOrFunction => {
      let newValue: UiOptions[T]
      if (typeof valueOrFunction === 'function') {
        newValue = valueOrFunction(option)
      } else {
        newValue = valueOrFunction
      }
      dispatch(setUi({
        options: { [optionKey]: newValue },
      }))
    },
    [dispatch, option, optionKey],
  )
  return [option, setOption]
}
