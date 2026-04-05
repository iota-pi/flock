import {
  ReactNode,
  useMemo,
  useState,
} from 'react'
import {
  List,
  ListItem,
  ListItemText,
  Divider,
  SxProps,
} from '@mui/material'
import { useVirtualizer } from '@tanstack/react-virtual'
import { GroupItem, Item } from '../../../state/items'
import { useGroupLookups } from '../hooks/useGroupLookups'
import { ItemListContextProvider } from './ItemListContext'
import { ItemListItem, type ItemListExtraElement } from './ItemListItem'

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

  const [listNode, setListNode] = useState<HTMLDivElement | null>(null)
  const groupsByMemberId = useGroupLookups()

  const useDynamicHeight = fullHeight && (wrapText || (extraElements && extraElements.length > 0) || compact)
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listNode,
    estimateSize: () => defaultRowHeight,
    getItemKey: index => items[index]?.id || index,
    overscan: 5,
    measureElement: useDynamicHeight
      ? element => element.getBoundingClientRect().height
      : undefined,
  })

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

  const renderContent = () => {
    if (items.length === 0) {
      return (
        <ListItem>
          <ListItemText primary={noItemsText} secondary={noItemsHint} />
        </ListItem>
      )
    }

    if (!fullHeight) {
      return items.map((_, index) => (
        <ItemListItem
          key={items[index].id}
          index={index}
          item={items[index]}
          itemsLength={items.length}
          style={{}}
          extraElements={extraElements}
          filterTags={filterTags}
          getActionIcon={getActionIcon}
          getChecked={getChecked}
          getDescription={getDescription}
          getForceFade={getForceFade}
          getHighlighted={getHighlighted}
          getIcon={getIcon}
          getTitle={getTitle}
          groupsByMemberId={groupsByMemberId}
          onCheck={onCheck}
          onClick={onClick}
          onClickAction={onClickAction}
        />
      ))
    }

    const virtualItems = rowVirtualizer.getVirtualItems()
    const fallbackItems = virtualItems.length === 0
      ? items.slice(0, Math.min(items.length, FALLBACK_RENDER_COUNT))
      : []

    return (
      <div
        ref={setListNode}
        style={{
          height: '100%',
          width: '100%',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            height: virtualItems.length > 0 ? rowVirtualizer.getTotalSize() : undefined,
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualItems.length > 0
            ? virtualItems.map(virtualRow => {
              const item = items[virtualRow.index]
              if (!item) {
                return null
              }

              return (
                <ItemListItem
                  key={item.id}
                  index={virtualRow.index}
                  item={item}
                  itemsLength={items.length}
                  style={{
                    left: 0,
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    width: '100%',
                  }}
                  measureElement={useDynamicHeight
                    ? node => {
                      if (node) {
                        rowVirtualizer.measureElement(node)
                      }
                    }
                    : undefined}
                  extraElements={extraElements}
                  filterTags={filterTags}
                  getActionIcon={getActionIcon}
                  getChecked={getChecked}
                  getDescription={getDescription}
                  getForceFade={getForceFade}
                  getHighlighted={getHighlighted}
                  getIcon={getIcon}
                  getTitle={getTitle}
                  groupsByMemberId={groupsByMemberId}
                  onCheck={onCheck}
                  onClick={onClick}
                  onClickAction={onClickAction}
                />
              )
            })
            : fallbackItems.map((item, index) => (
              <ItemListItem
                key={item.id}
                index={index}
                item={item}
                itemsLength={items.length}
                style={{}}
                extraElements={extraElements}
                filterTags={filterTags}
                getActionIcon={getActionIcon}
                getChecked={getChecked}
                getDescription={getDescription}
                getForceFade={getForceFade}
                getHighlighted={getHighlighted}
                getIcon={getIcon}
                getTitle={getTitle}
                groupsByMemberId={groupsByMemberId}
                onCheck={onCheck}
                onClick={onClick}
                onClickAction={onClickAction}
              />
            ))}
        </div>
      </div>
    )
  }

  return (
    <ItemListContextProvider value={listContextValue}>
      <List
        className={className}
        disablePadding={disablePadding}
        sx={rootStyles}
      >
        {dividers && items.length === 0 && <Divider />}

        {renderContent()}

        {dividers && <Divider />}
      </List>
    </ItemListContextProvider>
  )
}

export default ItemList
