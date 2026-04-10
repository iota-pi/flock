import {
  ReactNode,
  useMemo,
} from 'react'
import {
  List,
  ListItem,
  ListItemText,
  Divider,
  SxProps,
} from '@mui/material'
import { GroupItem, Item } from '../../../state/items'
import { useGroupLookups } from '../hooks/useGroupLookups'
import { ItemListContextProvider } from './ItemListContext'
import { type ItemListExtraElement } from './ItemListItem'
import {
  StandardItemList,
  VirtualizedItemList,
} from './ItemListStrategies'

const DEFAULT_ROW_HEIGHT = 58
const FALLBACK_RENDER_COUNT = 20
export interface BaseProps<T extends Item> {
  checkboxes?: boolean,
  checkboxSide?: 'left' | 'right',
  compact?: boolean,
  dividers?: boolean,
  extraElements?: ItemListExtraElement[],
  fadeArchived?: boolean,
  filterTags?: (tag: string) => boolean,
  getActionIcon?: (item: T) => ReactNode,
  getChecked?: (item: T) => boolean,
  getDescription?: (item: T) => string,
  getForceFade?: (item: T) => boolean,
  getHighlighted?: (item: T) => boolean,
  getIcon?: (item: T) => ReactNode,
  getTitle?: (item: T) => string,
  groupsByMemberId?: ReadonlyMap<string, GroupItem[]>,
  items: T[],
  linkTags?: boolean,
  maxTags?: number,
  onCheck?: (item: T) => void,
  onClick?: (item: T) => void,
  onClickAction?: (item: T) => void,
  showIcons?: boolean,
  showTags?: boolean,
  wrapText?: boolean,
}
export interface MultipleItemsProps<T extends Item> extends BaseProps<T> {
  className?: string,
  defaultRowHeight?: number,
  fullHeight?: boolean,
  disablePadding?: boolean,
  noItemsHint?: string,
  noItemsText?: string,
  paddingBottom?: number,
}

function ItemList<T extends Item>(props: MultipleItemsProps<T>) {
  const {
    getActionIcon,
    compact,
    checkboxes,
    checkboxSide,
    className,
    defaultRowHeight = DEFAULT_ROW_HEIGHT,
    disablePadding,
    dividers,
    extraElements,
    fadeArchived = true,
    filterTags,
    fullHeight = true,
    getChecked,
    getDescription,
    getForceFade,
    getHighlighted,
    getIcon,
    getTitle,
    items,
    linkTags = true,
    maxTags,
    noItemsHint,
    noItemsText,
    onClick,
    onClickAction,
    onCheck,
    paddingBottom,
    showIcons = false,
    showTags = true,
    wrapText,
  } = props

  const groupsByMemberId = useGroupLookups()

  const useDynamicHeight = Boolean(
    fullHeight && (wrapText || (extraElements && extraElements.length > 0) || compact),
  )

  const listContextValue = useMemo(
    () => ({
      checkboxes,
      checkboxSide,
      compact,
      dividers,
      fadeArchived,
      linkTags,
      maxTags,
      showIcons,
      showTags,
      wrapText: !!wrapText,
    }),
    [
      checkboxes,
      checkboxSide,
      compact,
      dividers,
      fadeArchived,
      linkTags,
      maxTags,
      showIcons,
      showTags,
      wrapText,
    ],
  )

  const rootStyles: SxProps = useMemo(
    () => ({
      paddingBottom,
      height: fullHeight ? '100%' : undefined,
    }),
    [fullHeight, paddingBottom],
  )

  const listRendererProps = {
    extraElements,
    filterTags,
    getActionIcon,
    getChecked,
    getDescription,
    getForceFade,
    getHighlighted,
    getIcon,
    getTitle,
    groupsByMemberId,
    items,
    onCheck,
    onClick,
    onClickAction,
  }

  const useVirtualizedList = fullHeight && items.length > FALLBACK_RENDER_COUNT

  const renderedContent = items.length === 0
    ? (
      <ListItem>
        <ListItemText primary={noItemsText} secondary={noItemsHint} />
      </ListItem>
    )
    : useVirtualizedList
      ? (
        <VirtualizedItemList
          {...listRendererProps}
          defaultRowHeight={defaultRowHeight}
          fallbackRenderCount={FALLBACK_RENDER_COUNT}
          useDynamicHeight={useDynamicHeight}
        />
      )
      : (
        <StandardItemList
          {...listRendererProps}
          fullHeight={fullHeight}
        />
      )

  return (
    <ItemListContextProvider value={listContextValue}>
      <List
        className={className}
        disablePadding={disablePadding}
        sx={rootStyles}
      >
        {dividers && items.length === 0 && <Divider />}

        {renderedContent}

        {dividers && <Divider />}
      </List>
    </ItemListContextProvider>
  )
}

export default ItemList
