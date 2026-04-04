import {
  MouseEvent,
  CSSProperties,
  ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react'
import {
  Box,
  Checkbox,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemIconProps,
  ListItemText,
  ListItemTextProps,
  styled,
  SxProps,
} from '@mui/material'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getItemName, GroupItem, isItem, Item } from '../../../state/items'
import TagDisplay from '../../../components/TagDisplay'
import { getIcon as getItemIcon } from '../../../components/Icons'
import { MostlyRequired } from '../../../utils'
import { useItems } from '../../../state/selectors'

const FADED_OPACITY = 0.65
const DEFAULT_ROW_HEIGHT = 58
const FALLBACK_RENDER_COUNT = 20

const StyledListItem = styled(ListItemButton)(
  () => ({
    '&.Mui-disabled': {
      opacity: '1 !important',
    },
  }),
)
const StyledListItemText = styled(
  ListItemText,
  {
    shouldForwardProp: prop => prop !== 'faded' && prop !== 'wrapText',
  },
)<ListItemTextProps & { faded?: boolean, wrapText: boolean }>(
  ({ faded, theme, wrapText }) => ({
    opacity: faded ? FADED_OPACITY : undefined,
    paddingRight: theme.spacing(2),
    transition: theme.transitions.create('opacity'),
    whiteSpace: !wrapText ? 'nowrap' : undefined,

    '& .MuiTypography-root': {
      textOverflow: !wrapText ? 'ellipsis' : undefined,
      overflow: !wrapText ? 'hidden' : undefined,
    },
  }),
)
const StyledListItemIcon = styled(
  ({ faded: _, ...props }: ListItemIconProps & { faded?: boolean }) => <ListItemIcon {...props} />,
)(({ faded, theme }) => ({
  opacity: faded ? FADED_OPACITY : undefined,
  transition: theme.transitions.create('opacity'),
}))
const ListItemIconRight = styled(ListItemIcon)(({ theme }) => ({
  justifyContent: 'flex-end',
  minWidth: theme.spacing(5),
}))

export interface ItemListExtraElement {
  content: ReactNode,
  index: number,
}
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

interface ItemListItemProps<T extends Item> extends BaseProps<T> {
  index: number
  style: CSSProperties
  measureElement?: (node: HTMLElement | null) => void
}

export function ItemListItem<T extends Item>(props: ItemListItemProps<T>) {
  const { index, style, measureElement, ...data } = props
  const {
    checkboxes,
    checkboxSide,
    compact,
    dividers,
    extraElements,
    fadeArchived,
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
    linkTags = true,
    maxTags,
    onClick,
    onClickAction,
    onCheck,
    showIcons = false,
    showTags = true,
    wrapText = false,
  } = data
  const item = items[index]

  const handleClick = useCallback(
    () => onClick?.(item),
    [item, onClick],
  )
  const handleClickAction = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation()
      if (onClickAction) {
        return onClickAction(item)
      } else if (onClick) {
        return onClick(item)
      }
      return undefined
    },
    [item, onClick, onClickAction],
  )
  const handleCheck = useCallback(
    (event: MouseEvent) => {
      if (onCheck) {
        event.stopPropagation()
        onCheck(item)
      }
    },
    [item, onCheck],
  )

  const actionIcon = useMemo(
    () => getActionIcon?.(item),
    [getActionIcon, item],
  )
  const checked = useMemo(() => getChecked?.(item), [getChecked, item])
  const icon = useMemo(
    () => getIcon?.(item) || (isItem(item) ? getItemIcon(item.type) : undefined),
    [getIcon, item],
  )
  const title = useMemo(
    () => getTitle?.(item) || (isItem(item) ? getItemName(item) : undefined),
    [getTitle, item],
  )
  const description = useMemo(
    () => {
      const defaultDescription = isItem(item) ? item.description : ''
      const base = getDescription ? getDescription(item) : defaultDescription
      const clipped = base.slice(0, 100)
      if (clipped.length < base.length) {
        const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '))
        return `${clippedToWord}…`
      }
      return base
    },
    [getDescription, item],
  )
  const groups = useMemo(
    () => groupsByMemberId?.get(item.id) || [],
    [groupsByMemberId, item.id],
  )
  const tags = useMemo(
    () => {
      const groupNames = groups.filter(g => !g.archived).map(g => g.name)
      if (filterTags) {
        return groupNames.filter(filterTags)
      }
      return groupNames
    },
    [filterTags, groups],
  )
  const groupIds = useMemo(
    () => linkTags ? groups.map(g => g.id) : undefined,
    [groups, linkTags],
  )

  const faded = useMemo(
    () => {
      if (isItem(item) && item.archived && fadeArchived) {
        return true
      }
      if (getForceFade && getForceFade(item)) {
        return true
      }
      return false
    },
    [fadeArchived, getForceFade, item],
  )
  const highlighted = useMemo(() => getHighlighted?.(item), [getHighlighted, item])

  const CheckboxHolder = checkboxSide === 'right' ? ListItemIconRight : ListItemIcon
  const checkbox = checkboxes && onCheck && (
    <CheckboxHolder>
      <Checkbox
        data-cy="list-item-checkbox"
        edge={checkboxSide && (checkboxSide === 'left' ? 'start' : 'end')}
        checked={checked}
        tabIndex={-1}
        onClick={handleCheck}
        slotProps={{ input: { 'aria-labelledby': `${item.id}-text` } }}
      />
    </CheckboxHolder>
  )

  const extras = useMemo(
    () => (extraElements || []).filter(e => e.index === index).map(e => e.content),
    [extraElements, index],
  )
  const endExtras = useMemo(
    () => (
      index === items.length - 1
      && (
        (extraElements || [])
          .filter(e => e.index === -1 || e.index > index)
          .map(e => e.content)
      )
    ),
    [extraElements, index, items.length],
  )

  return (
    <div style={style} ref={measureElement} data-index={index}>
      {extras}

      {dividers && <Divider />}

      <StyledListItem
        data-cy="list-item"
        disabled={!onClick && !onCheck && !onClickAction}
        selected={highlighted || false}
        onClick={onClick ? handleClick : undefined}
        dense={compact}
      >
        {checkboxSide !== 'right' && checkbox}

        {showIcons && icon && (
          <StyledListItemIcon faded={faded}>
            {icon}
          </StyledListItemIcon>
        )}

        <Box
          display="flex"
          flexDirection="row"
          flexGrow={1}
          minWidth={0}
        >
          <Box
            display="flex"
            alignItems="center"
            flexGrow={1}
            minWidth={0}
          >
            <StyledListItemText
              faded={faded}
              wrapText={wrapText}
              id={`${item.id}-text`}
              primary={title}
              secondary={description || undefined}
            />
          </Box>

          <Box flexGrow={1} />

          {showTags && isItem(item) && (
            <TagDisplay
              tags={tags}
              linkedIds={groupIds}
              max={maxTags}
            />
          )}
        </Box>

        {actionIcon && (
          <Box ml={2}>
            <IconButton
              aria-label="List item action"
              data-cy="list-item-action"
              disableRipple={!onClickAction}
              onClick={handleClickAction}
              size="large"
              sx={{
                '&:hover': !onClickAction ? {
                  backgroundColor: 'transparent',
                } : {},
              }}
            >
              {actionIcon}
            </IconButton>
          </Box>
        )}

        {checkboxSide === 'right' && checkbox}
      </StyledListItem>

      {endExtras}
    </div>
  )
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
  const allGroups = useItems('group') as GroupItem[]
  const groupsByMemberId = useMemo(() => {
    const lookup = new Map<string, GroupItem[]>()
    for (const group of allGroups) {
      const members = Array.isArray(group.members) ? group.members : []
      for (const memberId of members) {
        const existing = lookup.get(memberId)
        if (existing) {
          existing.push(group)
        } else {
          lookup.set(memberId, [group])
        }
      }
    }
    return lookup
  }, [allGroups])

  const useDynamicHeight = fullHeight && (wrapText || (extraElements && extraElements.length > 0) || compact)
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

  const itemData: MostlyRequired<BaseProps<T>> = useMemo(
    () => ({
      items,
      getActionIcon,
      compact,
      checkboxSide,
      checkboxes,
      dividers,
      extraElements,
      fadeArchived,
      filterTags,
      getChecked,
      getDescription,
      getForceFade,
      getHighlighted,
      getIcon,
      getTitle,
      groupsByMemberId,
      linkTags,
      maxTags,
      onCheck,
      onClick,
      onClickAction,
      showIcons,
      showTags,
      wrapText,
    }),
    [
      getActionIcon,
      compact,
      checkboxSide,
      checkboxes,
      dividers,
      extraElements,
      fadeArchived,
      filterTags,
      getChecked,
      getDescription,
      getForceFade,
      getHighlighted,
      getIcon,
      getTitle,
      groupsByMemberId,
      items,
      linkTags,
      maxTags,
      onCheck,
      onClick,
      onClickAction,
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
          style={{}}
          {...itemData}
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
                  {...itemData}
                />
              )
            })
            : fallbackItems.map((item, index) => (
              <ItemListItem
                key={item.id}
                index={index}
                style={{}}
                {...itemData}
              />
            ))}
        </div>
      </div>
    )
  }

  return (
    <List
      className={className}
      disablePadding={disablePadding}
      sx={rootStyles}
    >
      {dividers && items.length === 0 && <Divider />}

      {renderContent()}

      {dividers && <Divider />}
    </List>
  )
}

export default ItemList
