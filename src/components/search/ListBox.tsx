import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import SearchableRow, { PropsAndOption } from './Row'

const LISTBOX_PADDING = 8
const FALLBACK_RENDER_COUNT = 20

export interface SearchListVirtualizerApi {
  scrollToIndex: (index: number) => void
}

function isPropsAndOption(child: unknown): child is PropsAndOption {
  if (!Array.isArray(child) || child.length < 3) {
    return false
  }

  const option = child[1]
  return typeof option === 'object'
    && option !== null
    && 'id' in option
    && typeof option.id === 'string'
}

const ListBoxComponent = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLElement> & {
    internalListRef: React.Ref<SearchListVirtualizerApi | null>;
    onItemsBuilt: (optionIndexMap: Map<string, number>) => void;
  }
>(
  (props, ref) => {
    const { children, internalListRef, onItemsBuilt, ...otherProps } = props
    const itemData = useMemo<PropsAndOption[]>(
      () => {
        const rawChildren: unknown[] = Array.isArray(children)
          ? children
          : [children]
        return rawChildren.filter(isPropsAndOption)
      },
      [children],
    )
    const optionIndexMap = useMemo(
      () => {
        const indexMap = new Map<string, number>()
        itemData.forEach((item, index) => {
          indexMap.set(item[1].id, index)
        })
        return indexMap
      },
      [itemData],
    )
    const itemSize = 56

    const itemsHeight = itemSize * Math.min(itemData.length, 6)
    const scrollElementRef = useRef<HTMLDivElement | null>(null)
    // eslint-disable-next-line react-hooks/incompatible-library
    const virtualizer = useVirtualizer({
      count: itemData.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => itemSize,
      getItemKey: index => itemData[index]?.[1]?.id || index,
      overscan: 2,
    })
    const virtualItems = virtualizer.getVirtualItems()

    useImperativeHandle(internalListRef, () => ({
      scrollToIndex: (index: number) => {
        virtualizer.scrollToIndex(index, { align: 'auto' })
      },
    }), [virtualizer])

    useEffect(
      () => {
        onItemsBuilt(optionIndexMap)
      },
      [onItemsBuilt, optionIndexMap],
    )

    const { className, style: _, ...listboxProps } = otherProps

    return (
      <div
        ref={ref}
        {...listboxProps}
        style={{
          paddingTop: LISTBOX_PADDING,
          paddingBottom: LISTBOX_PADDING,
        }}
      >
        <div
          className={className}
          ref={scrollElementRef}
          style={{
            height: itemsHeight,
            width: '100%',
            overflowY: 'auto',
          }}
        >
          <ul
            style={{
              height: virtualItems.length > 0 ? virtualizer.getTotalSize() : undefined,
              margin: 0,
              padding: 0,
              position: 'relative',
            }}
          >
            {virtualItems.length > 0
              ? virtualItems.map(virtualRow => {
                const row = itemData[virtualRow.index]
                if (!row) {
                  return null
                }

                return (
                  <SearchableRow
                    key={row[1].id}
                    itemData={itemData}
                    index={virtualRow.index}
                    style={{
                      left: 0,
                      position: 'absolute',
                      top: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      width: '100%',
                    }}
                  />
                )
              })
              : itemData.slice(0, Math.min(itemData.length, FALLBACK_RENDER_COUNT)).map((item, index) => (
                <SearchableRow
                  key={item[1].id}
                  itemData={itemData}
                  index={index}
                  style={{}}
                />
              ))}
          </ul>
        </div>
      </div>
    )
  },
)
ListBoxComponent.displayName = 'ListBoxComponent'

export default ListBoxComponent
