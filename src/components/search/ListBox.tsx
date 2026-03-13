import { forwardRef, useEffect, useMemo } from 'react'
import { List, ListImperativeAPI } from 'react-window'
import SearchableRow, { PropsAndOption, SearchableRowProps } from './Row'

const LISTBOX_PADDING = 8

const ListBoxComponent = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLElement> & {
    internalListRef: React.Ref<ListImperativeAPI>;
    onItemsBuilt: (optionIndexMap: Map<string, number>) => void;
  }
>(
  (props, ref) => {
    const { children, internalListRef, onItemsBuilt, ...otherProps } = props
    const itemData = useMemo(
      () => children as PropsAndOption[],
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
        <List<SearchableRowProps>
          className={className}
          listRef={internalListRef}
          rowProps={{ itemData }}
          style={{
            height: itemsHeight,
            width: '100%',
          }}
          rowComponent={SearchableRow}
          rowHeight={itemSize}
          overscanCount={2}
          rowCount={itemData.length}
        />
      </div>
    )
  },
)
ListBoxComponent.displayName = 'ListBoxComponent'

export default ListBoxComponent
