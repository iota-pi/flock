import { type CSSProperties, ReactNode, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { GroupItem, Item } from '../../../state/items'
import { ItemListItem, type ItemListExtraElement } from './ItemListItem'

type ItemListRendererProps<T extends Item> = {
  extraElements?: ItemListExtraElement[]
  filterTags?: (tag: string) => boolean
  getActionIcon?: (item: T) => ReactNode
  getChecked?: (item: T) => boolean
  getDescription?: (item: T) => string
  getForceFade?: (item: T) => boolean
  getHighlighted?: (item: T) => boolean
  getIcon?: (item: T) => ReactNode
  getTitle?: (item: T) => string
  groupsByMemberId: ReadonlyMap<string, GroupItem[]>
  items: T[]
  onCheck?: (item: T) => void
  onClick?: (item: T) => void
  onClickAction?: (item: T) => void
}

type StandardItemListProps<T extends Item> = ItemListRendererProps<T> & {
  fullHeight: boolean
}

type VirtualizedItemListProps<T extends Item> = ItemListRendererProps<T> & {
  defaultRowHeight: number
  fallbackRenderCount: number
  useDynamicHeight: boolean
}

function createItemListItem<T extends Item>(
  item: T,
  index: number,
  itemsLength: number,
  props: ItemListRendererProps<T>,
  style: CSSProperties,
  measureElement?: (node: HTMLElement | null) => void,
) {
  return (
    <ItemListItem
      key={item.id}
      index={index}
      item={item}
      itemsLength={itemsLength}
      style={style}
      measureElement={measureElement}
      extraElements={props.extraElements}
      filterTags={props.filterTags}
      getActionIcon={props.getActionIcon}
      getChecked={props.getChecked}
      getDescription={props.getDescription}
      getForceFade={props.getForceFade}
      getHighlighted={props.getHighlighted}
      getIcon={props.getIcon}
      getTitle={props.getTitle}
      groupsByMemberId={props.groupsByMemberId}
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
    createItemListItem(item, index, items.length, { items, ...props }, {})
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
              items.length,
              { items, ...props },
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
            createItemListItem(item, index, items.length, { items, ...props }, {})
          ))}
      </div>
    </div>
  )
}