import { Dispatch, SetStateAction, useCallback, useMemo } from 'react'
import { useSelector } from 'react-redux'
import { useAppDispatch, useAppSelector } from '../store'
import { DEFAULT_CRITERIA } from '../utils/customSort'
import { AccountMetadata as Metadata, MetadataKey } from './account'
import { getTags, Item, ItemId, selectAllItems, selectItems } from './items'
import { setUi, UiOptions } from './ui'
import { setMetadata } from '../api/Vault'

export function useItems<T extends Item>(itemType: T['type']): T[]
export function useItems(): Item[]
export function useItems<T extends Item>(itemType?: T['type']): T[] {
  const items = useSelector(selectAllItems)
  return useMemo(
    () => (
      itemType
        ? items.filter(i => i.type === itemType)
        : items
    ) as T[],
    [items, itemType],
  )
}

export const useItemMap = () => useSelector(selectItems)
export const useItem = (id: ItemId) => useAppSelector(
  state => {
    const item: Item | undefined = state.items.entities[id]
    if (item) {
      return item
    }
    return undefined
  },
)

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
  const metadata = useAppSelector(state => state.account.metadata)

  const value = metadata[key] === undefined ? defaultValue : metadata[key]
  const setValue = useCallback(
    async (newValueOrFunc: Metadata[K] | ((prev: Metadata[K]) => Metadata[K])) => {
      const newValue = typeof newValueOrFunc === 'function' ? newValueOrFunc(value) : newValueOrFunc
      const newMetadata = { ...metadata, [key]: newValue }
      await setMetadata(newMetadata)
    },
    [key, metadata, value],
  )
  return [value, setValue]
}

export const useSortCriteria = () => useMetadata('sortCriteria', DEFAULT_CRITERIA)

export const useTags = () => {
  const items = useItems()
  const tags = useMemo(
    () => getTags(items),
    [items],
  )
  return tags
}

export const useIsActive = () => {
  const drawers = useAppSelector(state => state.ui.drawers)
  return useCallback(
    (itemId: ItemId, report?: boolean) => (
      drawers.findIndex(drawer => (
        drawer.open
        && drawer.item === itemId
        && (report === undefined || !report === !drawer.report)
      )) > -1
    ),
    [drawers],
  )
}

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
