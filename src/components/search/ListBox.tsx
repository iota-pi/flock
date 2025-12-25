import { ForwardedRef, forwardRef, HTMLAttributes, PropsWithChildren } from 'react'
import { List } from 'react-window'
import SearchableRow, { PropsAndOption, SearchableRowProps } from './Row'

const LISTBOX_PADDING = 8

const ListBoxComponent = forwardRef(
  (
    props: PropsWithChildren<HTMLAttributes<HTMLElement>>,
    ref: ForwardedRef<HTMLDivElement>,
  ) => {
    const { children, ...otherProps } = props
    const itemData = children as PropsAndOption[]
    const itemSize = 56

    const itemsHeight = itemSize * Math.min(itemData.length, 6)

    return (
      <div
        ref={ref}
        {...otherProps}
        style={{
          paddingTop: LISTBOX_PADDING,
          paddingBottom: LISTBOX_PADDING,
        }}
      >
        <List<SearchableRowProps>
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
