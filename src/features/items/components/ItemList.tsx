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
import { Item } from '../../../state/items'
import { useGroupLookupMap, type GroupLookupData } from '../../../state/selectors'
import { ItemListContextProvider } from './ItemListContext'
import {
  StandardItemList,
  VirtualizedItemList,
} from './ItemListStrategies'
import { useNavigationStore } from '../../../state/navigationStore'
import { useShallow } from 'zustand/react/shallow'

const DEFAULT_ROW_HEIGHT = 58
const FALLBACK_RENDER_COUNT = 20
interface BaseProps {
  checkboxes?: boolean,
  checkboxSide?: 'left' | 'right',
  compact?: boolean,
  dividers?: boolean,
  fadeArchived?: boolean,
  filterTags?: (tag: string) => boolean,
  getActionIcon?: (item: Item) => ReactNode,
  getChecked?: (item: Item) => boolean,
  getDescription?: (item: Item) => string,
  getForceFade?: (item: Item) => boolean,
  getHighlighted?: (item: Item) => boolean,
  getIcon?: (item: Item) => ReactNode,
  getTitle?: (item: Item) => string,
  groupsByMemberId?: ReadonlyMap<string, GroupLookupData>,
  itemIds: string[],
  linkTags?: boolean,
  maxTags?: number,
  onCheck?: (item: Item) => void,
  onClick?: (item: Item) => void,
  onClickAction?: (item: Item) => void,
  showIcons?: boolean,
  showTags?: boolean,
  wrapText?: boolean,
}
interface MultipleItemsProps extends BaseProps {
  className?: string,
  defaultRowHeight?: number,
  fullHeight?: boolean,
  disablePadding?: boolean,
  noItemsHint?: string,
  noItemsText?: string,
  paddingBottom?: number,
}

const selectActiveDrawerItemIds = (state: ReturnType<typeof useNavigationStore.getState>) => {
  const activeDrawerItemIds = new Set<string>()

  for (const drawer of state.drawers) {
    if (drawer.item) {
      activeDrawerItemIds.add(drawer.item)
    }
  }

  return Array.from(activeDrawerItemIds).sort()
}

function ItemList(props: MultipleItemsProps) {
  const {
    getActionIcon,
    compact,
    checkboxes,
    checkboxSide,
    className,
    defaultRowHeight = DEFAULT_ROW_HEIGHT,
    disablePadding,
    dividers,
    fadeArchived = true,
    filterTags,
    fullHeight = true,
    getChecked,
    getDescription,
    getForceFade,
    getHighlighted,
    getIcon,
    getTitle,
    itemIds,
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

  const groupsByMemberId = useGroupLookupMap()
  const activeDrawerItemIds = useNavigationStore(useShallow(selectActiveDrawerItemIds))
  const highlightedItemIds = useMemo(
    () => new Set(activeDrawerItemIds),
    [activeDrawerItemIds],
  )

  const useDynamicHeight = Boolean(
    fullHeight && (wrapText || compact),
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

  const listRendererProps = useMemo(
    () => ({
      filterTags,
      getActionIcon,
      getChecked,
      getDescription,
      getForceFade,
      getHighlighted,
      getIcon,
      getTitle,
      groupsByMemberId,
      highlightedItemIds,
      itemIds,
      onCheck,
      onClick,
      onClickAction,
    }),
    [
      filterTags,
      getActionIcon,
      getChecked,
      getDescription,
      getForceFade,
      getHighlighted,
      getIcon,
      getTitle,
      groupsByMemberId,
      highlightedItemIds,
      itemIds,
      onCheck,
      onClick,
      onClickAction,
    ],
  )

  const useVirtualizedList = fullHeight && itemIds.length > FALLBACK_RENDER_COUNT

  const renderedContent = itemIds.length === 0
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
        {dividers && itemIds.length === 0 && <Divider />}

        {renderedContent}

        {dividers && <Divider />}
      </List>
    </ItemListContextProvider>
  )
}

export default ItemList
