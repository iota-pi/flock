import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
} from 'react'
import {
  Checkbox,
  Divider,
  IconButton,
  ListItemButton,
  ListItemIcon,
  type ListItemIconProps,
  ListItemText,
  type ListItemTextProps,
  styled,
  useTheme,
} from '@mui/material'
import TagDisplay from 'src/components/TagDisplay'
import { getIcon as getItemIcon } from 'src/components/Icons'
import { getItemName, isItem, type Item } from 'src/state/items'
import { useAutomergeItem } from 'src/sync/useAutomerge'
import { type GroupLookupData } from '../hooks/useGroupLookups'
import { useItemListContext } from './ItemListContext'

const FADED_OPACITY = 0.65

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
)<ListItemTextProps & { faded?: boolean; wrapText: boolean }>(
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

interface ItemListItemProps {
  index: number
  style: CSSProperties
  itemId: string
  measureElement?: (node: HTMLElement | null) => void
  filterTags?: (tag: string) => boolean
  getActionIcon?: (item: Item) => ReactNode
  getChecked?: (item: Item) => boolean
  getDescription?: (item: Item) => string
  getForceFade?: (item: Item) => boolean
  getIcon?: (item: Item) => ReactNode
  getTitle?: (item: Item) => string
  groupsByMemberId?: ReadonlyMap<string, GroupLookupData>
  highlighted?: boolean
  onCheck?: (item: Item) => void
  onClick?: (item: Item) => void
  onClickAction?: (item: Item) => void
}

export function ItemListItem(props: ItemListItemProps) {
  const {
    index,
    style,
    itemId,
    measureElement,
    filterTags,
    getActionIcon,
    getChecked,
    getDescription,
    getForceFade,
    getIcon,
    getTitle,
    groupsByMemberId,
    highlighted,
    onCheck,
    onClick,
    onClickAction,
  } = props

  const {
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
  } = useItemListContext()
  
  const item = useAutomergeItem(itemId)

  const currentItem = item

  const handleClick = useCallback(
    () => {
      if (currentItem) {
        onClick?.(currentItem)
      }
    },
    [currentItem, onClick],
  )

  const handleClickAction = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation()
      if (!currentItem) {
        return undefined
      }
      if (onClickAction) {
        return onClickAction(currentItem)
      }
      if (onClick) {
        return onClick(currentItem)
      }
      return undefined
    },
    [currentItem, onClick, onClickAction],
  )

  const handleCheck = useCallback(
    (event: MouseEvent) => {
      if (onCheck && currentItem) {
        event.stopPropagation()
        onCheck(currentItem)
      }
    },
    [currentItem, onCheck],
  )

  const actionIcon = useMemo(
    () => (currentItem ? getActionIcon?.(currentItem) : undefined),
    [currentItem, getActionIcon],
  )
  const checked = useMemo(() => (currentItem ? getChecked?.(currentItem) : false), [currentItem, getChecked])
  const icon = useMemo(
    () => (currentItem ? (getIcon?.(currentItem) || getItemIcon(currentItem.type)) : undefined),
    [currentItem, getIcon],
  )
  const title = useMemo(
    () => (currentItem ? (getTitle?.(currentItem) || getItemName(currentItem)) : ''),
    [currentItem, getTitle],
  )
  const description = useMemo(
    () => {
      if (!currentItem) {
        return ''
      }
      const defaultDescription = currentItem.description ?? ''
      const base = getDescription ? getDescription(currentItem) : defaultDescription
      const clipped = base.slice(0, 100)
      if (clipped.length < base.length) {
        const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '))
        return `${clippedToWord}…`
      }
      return base
    },
    [currentItem, getDescription],
  )
  const groupLookup = useMemo(
    () => (currentItem ? groupsByMemberId?.get(currentItem.id) : undefined),
    [currentItem, groupsByMemberId],
  )
  const tags = useMemo(
    () => {
      const groupNames = groupLookup?.tags ?? []
      if (filterTags) {
        return groupNames.filter(filterTags)
      }
      return groupNames
    },
    [filterTags, groupLookup],
  )
  const groupIds = useMemo(
    () => linkTags ? groupLookup?.groupIds : undefined,
    [groupLookup, linkTags],
  )

  const faded = useMemo(
    () => {
      if (currentItem && isItem(currentItem) && currentItem.archived && fadeArchived) {
        return true
      }
      if (currentItem && getForceFade && getForceFade(currentItem)) {
        return true
      }
      return false
    },
    [currentItem, fadeArchived, getForceFade],
  )
  const isHighlighted = highlighted ?? false

  const CheckboxHolder = checkboxSide === 'right' ? ListItemIconRight : ListItemIcon
  const checkbox = checkboxes && onCheck && (
    <CheckboxHolder>
      <Checkbox
        data-cy="list-item-checkbox"
        edge={checkboxSide && (checkboxSide === 'left' ? 'start' : 'end')}
        checked={checked}
        tabIndex={-1}
        onClick={handleCheck}
        slotProps={{ input: { 'aria-labelledby': `${currentItem?.id}-text` } }}
      />
    </CheckboxHolder>
  )

  const marginLeft = useTheme().spacing(2)

  if (!currentItem) {
    return (
      <div style={style} ref={measureElement} data-index={index}>
        {dividers && <Divider />}
        <StyledListItem data-cy="list-item-loading" disabled dense={compact}>
          <ListItemText primary="..." />
        </StyledListItem>
      </div>
    )
  }

  return (
    <div style={style} ref={measureElement} data-index={index}>
      {dividers && <Divider />}

      <StyledListItem
        data-cy="list-item"
        disabled={!onClick && !onCheck && !onClickAction}
        selected={isHighlighted}
        onClick={onClick ? handleClick : undefined}
        dense={compact}
      >
        {checkboxSide !== 'right' && checkbox}

        {showIcons && icon && (
          <StyledListItemIcon faded={faded}>
            {icon}
          </StyledListItemIcon>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            flexGrow: 1,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexGrow: 1,
              minWidth: 0,
            }}
          >
            <StyledListItemText
              faded={faded}
              wrapText={wrapText}
              id={`${currentItem.id}-text`}
              primary={title}
              secondary={description || undefined}
            />
          </div>

          <div style={{ flexGrow: 1 }} />

          {showTags && isItem(currentItem) && (
            <TagDisplay
              tags={tags}
              linkedIds={groupIds}
              max={maxTags}
            />
          )}
        </div>

        {actionIcon && (
          <div style={{ marginLeft }}>
            <IconButton
              aria-label="List item action"
              data-cy="list-item-action"
              disableRipple={!onClickAction}
              onClick={handleClickAction}
              size="large"
              sx={{
                '&:hover': !onClickAction ? { backgroundColor: 'transparent' } : {},
              }}
            >
              {actionIcon}
            </IconButton>
          </div>
        )}

        {checkboxSide === 'right' && checkbox}
      </StyledListItem>
    </div>
  )
}
