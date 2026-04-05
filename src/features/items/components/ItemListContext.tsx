import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

type ItemListContextValue = {
  checkboxes?: boolean
  checkboxSide?: 'left' | 'right'
  compact?: boolean
  dividers?: boolean
  fadeArchived?: boolean
  linkTags: boolean
  maxTags?: number
  showIcons: boolean
  showTags: boolean
  wrapText: boolean
}

const DEFAULT_CONTEXT: ItemListContextValue = {
  checkboxes: false,
  checkboxSide: 'left',
  compact: false,
  dividers: false,
  fadeArchived: true,
  linkTags: true,
  maxTags: undefined,
  showIcons: false,
  showTags: true,
  wrapText: false,
}

const ItemListContext = createContext<ItemListContextValue>(DEFAULT_CONTEXT)

export function ItemListContextProvider(
  { value, children }: { value: ItemListContextValue; children: ReactNode },
) {
  return (
    <ItemListContext.Provider value={value}>
      {children}
    </ItemListContext.Provider>
  )
}

export function useItemListContext(): ItemListContextValue {
  return useContext(ItemListContext)
}
