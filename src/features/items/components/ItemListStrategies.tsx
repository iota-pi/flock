import { type CSSProperties, ReactNode, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Item } from '../../../state/items'
import { type GroupLookupData } from '../hooks/useGroupLookups'
import { ItemListItem } from './ItemListItem'

type ItemListRendererProps<T extends Item> = {
  filterTags?: (tag: string) => boolean
  getActionIcon?: (item: T) => ReactNode
  getChecked?: (item: T) => boolean
  getDescription?: (item: T) => string
  getForceFade?: (item: T) => boolean
  getHighlighted?: (item: T) => boolean
  getIcon?: (item: T) => ReactNode
  getTitle?: (item: T) => string
  groupsByMemberId: ReadonlyMap<string, GroupLookupData>
  highlightedItemIds: ReadonlySet<string>
  onCheck?: (item: T) => void
  onClick?: (item: T) => void
  onClickAction?: (item: T) => void
}

type StandardItemListProps<T extends Item> = ItemListRendererProps<T> & {
  fullHeight: boolean
  items: T[]
}

type VirtualizedItemListProps<T extends Item> = ItemListRendererProps<T> & {
  defaultRowHeight: number
  fallbackRenderCount: number
  items: T[]
  useDynamicHeight: boolean
}

const EMPTY_STYLE: CSSProperties = {}

function createItemListItem<T extends Item>(
  item: T,
  index: number,
  props: ItemListRendererProps<T>,
  style: CSSProperties,
  measureElement?: (node: HTMLElement | null) => void,
) {
  const highlighted = props.getHighlighted?.(item) ?? props.highlightedItemIds.has(item.id)

  return (
    <ItemListItem
      key={item.id}
      index={index}
      item={item}
      style={style}
      measureElement={measureElement}
      filterTags={props.filterTags}
      getActionIcon={props.getActionIcon}
      getChecked={props.getChecked}
      getDescription={props.getDescription}
      getForceFade={props.getForceFade}
      getIcon={props.getIcon}
      getTitle={props.getTitle}
      groupsByMemberId={props.groupsByMemberId}
      highlighted={highlighted}
      onCheck={props.onCheck}
      onClick={props.onClick}
      onClickAction={props.onClickAction}
    />
  )
}

export function StandardItemList<T extends Item>({
  fullHeight,
  items,
  ...props
}: StandardItemListProps<T>) {
  const content = items.map((item, index) => (
    createItemListItem(item, index, props, EMPTY_STYLE)
  ))

  if (!fullHeight) {
    return <>{content}</>
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        width: '100%',
      }}
    >
      {content}
    </div>
  )
}

export function VirtualizedItemList<T extends Item>({
  defaultRowHeight,
  fallbackRenderCount,
  items,
  useDynamicHeight,
  ...props
}: VirtualizedItemListProps<T>) {
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null)

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

  const virtualItems = rowVirtualizer.getVirtualItems()
  const fallbackItems = virtualItems.length === 0
    ? items.slice(0, Math.min(items.length, fallbackRenderCount))
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

            return createItemListItem(
              item,
              virtualRow.index,
              props,
              {
                left: 0,
                position: 'absolute',
                top: 0,
                transform: `translateY(${virtualRow.start}px)`,
                width: '100%',
              },
              useDynamicHeight
                ? node => {
                  if (node) {
                    rowVirtualizer.measureElement(node)
                  }
                }
                : undefined,
            )
          })
          : fallbackItems.map((item, index) => (
            createItemListItem(item, index, props, EMPTY_STYLE)
          ))}
      </div>
    </div>
  )
}