import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
} from 'react'
import Checkbox from '@mui/material/Checkbox'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import { styled, useTheme } from '@mui/material/styles'
import type { ListItemIconProps } from '@mui/material/ListItemIcon'
import type { ListItemTextProps } from '@mui/material/ListItemText'

import TagDisplay from 'src/components/TagDisplay'
import { getIcon as getItemIcon } from 'src/components/Icons'
import { getItemName, isItem, type Item } from 'src/state/items'
import { useItem } from 'src/state/selectors'
import { useItemListContext } from './ItemListContext'
import type { GroupLookupData } from 'src/shared/itemTypes'
import type { ItemId } from 'src/shared/schemas/items'


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
  itemId: ItemId
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

  const item = useItem(itemId)

  const handleClick = useCallback(
    () => {
      if (item) {
        onClick?.(item)
      }
    },
    [item, onClick],
  )

  const handleClickAction = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation()
      if (!item) {
        return undefined
      }
      if (onClickAction) {
        return onClickAction(item)
      }
      if (onClick) {
        return onClick(item)
      }
      return undefined
    },
    [item, onClick, onClickAction],
  )

  const handleCheck = useCallback(
    (event: MouseEvent) => {
      if (onCheck && item) {
        event.stopPropagation()
        onCheck(item)
      }
    },
    [item, onCheck],
  )

  const actionIcon = useMemo(
    () => (item ? getActionIcon?.(item) : undefined),
    [item, getActionIcon],
  )
  const checked = useMemo(() => (item ? getChecked?.(item) : false), [item, getChecked])
  const icon = useMemo(
    () => (item ? (getIcon?.(item) || getItemIcon(item.type)) : undefined),
    [item, getIcon],
  )
  const title = useMemo(
    () => (item ? (getTitle?.(item) || getItemName(item)) : ''),
    [item, getTitle],
  )
  const description = useMemo(
    () => {
      if (!item) {
        return ''
      }
      const defaultDescription = item.description ?? ''
      const base = getDescription ? getDescription(item) : defaultDescription
      const clipped = base.slice(0, 100)
      if (clipped.length < base.length) {
        const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '))
        return `${clippedToWord}…`
      }
      return base
    },
    [item, getDescription],
  )
  const groupLookup = useMemo(
    () => (item ? groupsByMemberId?.get(item.id) : undefined),
    [item, groupsByMemberId],
  )
  const tags = useMemo(
    () => {
      const groupNames = groupLookup?.groupNames ?? []
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
      if (item && isItem(item) && item.archived && fadeArchived) {
        return true
      }
      if (item && getForceFade && getForceFade(item)) {
        return true
      }
      return false
    },
    [item, fadeArchived, getForceFade],
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
        inputProps={{ 'aria-label': `Select ${name || 'item'}` }}
        slotProps={{
          input: { 'aria-label': `Select ${name || 'item'}` },
          htmlInput: { 'aria-label': `Select ${name || 'item'}` },
        }}
      />
    </CheckboxHolder>
  )

  const marginLeft = useTheme().spacing(2)

  if (!item) {
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
              id={`${item.id}-text`}
              primary={title}
              secondary={description || undefined}
            />
          </div>

          <div style={{ flexGrow: 1 }} />

          {showTags && isItem(item) && (
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
