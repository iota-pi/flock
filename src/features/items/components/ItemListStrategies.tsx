import { type CSSProperties, ReactNode, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Item } from '../../../state/items'
import { ItemListItem } from './ItemListItem'
import type { GroupLookupData } from 'src/shared/itemTypes'

type ItemListRendererProps = {
  filterTags?: (tag: string) => boolean
  getActionIcon?: (item: Item) => ReactNode
  getChecked?: (item: Item) => boolean
  getDescription?: (item: Item) => string
  getForceFade?: (item: Item) => boolean
  getHighlighted?: (item: Item) => boolean
  getIcon?: (item: Item) => ReactNode
  getTitle?: (item: Item) => string
  groupsByMemberId: ReadonlyMap<string, GroupLookupData>
  highlightedItemIds: ReadonlySet<string>
  onCheck?: (item: Item) => void
  onClick?: (item: Item) => void
  onClickAction?: (item: Item) => void
}

type StandardItemListProps = ItemListRendererProps & {
  fullHeight: boolean
  itemIds: string[]
}

type VirtualizedItemListProps = ItemListRendererProps & {
  defaultRowHeight: number
  fallbackRenderCount: number
  itemIds: string[]
  useDynamicHeight: boolean
}

const EMPTY_STYLE: CSSProperties = {}

function createItemListItem(
  itemId: string,
  index: number,
  props: ItemListRendererProps,
  style: CSSProperties,
  measureElement?: (node: HTMLElement | null) => void,
) {
  const highlighted = props.highlightedItemIds.has(itemId)

  return (
    <ItemListItem
      key={itemId}
      index={index}
      itemId={itemId}
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

export function StandardItemList({
  fullHeight,
  itemIds,
  ...props
}: StandardItemListProps) {
  const content = itemIds.map((itemId, index) => (
    createItemListItem(itemId, index, props, EMPTY_STYLE)
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

export function VirtualizedItemList({
  defaultRowHeight,
  fallbackRenderCount,
  itemIds,
  useDynamicHeight,
  ...props
}: VirtualizedItemListProps) {
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null)

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: itemIds.length,
    getScrollElement: () => listNode,
    estimateSize: () => defaultRowHeight,
    getItemKey: index => itemIds[index] || index,
    overscan: 10,
    measureElement: useDynamicHeight
      ? element => element.getBoundingClientRect().height
      : undefined,
  })

  const virtualItems = rowVirtualizer.getVirtualItems()
  const fallbackItems = virtualItems.length === 0
    ? itemIds.slice(0, Math.min(itemIds.length, fallbackRenderCount))
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
            const itemId = itemIds[virtualRow.index]
            if (!itemId) {
              return null
            }

            return createItemListItem(
              itemId,
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
          : fallbackItems.map((itemId, index) => (
            createItemListItem(itemId, index, props, EMPTY_STYLE)
          ))}
      </div>
    </div>
  )
}