import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
} from 'react'
import {
  Box,
  Checkbox,
  Divider,
  IconButton,
  ListItemButton,
  ListItemIcon,
  type ListItemIconProps,
  ListItemText,
  type ListItemTextProps,
  styled,
} from '@mui/material'
import TagDisplay from '../../../components/TagDisplay'
import { getIcon as getItemIcon } from '../../../components/Icons'
import { getItemName, type GroupItem, isItem, type Item } from '../../../state/items'
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

export interface ItemListExtraElement {
  content: ReactNode
  index: number
}

export interface ItemListItemProps<T extends Item> {
  index: number
  style: CSSProperties
  item: T
  itemsLength: number
  measureElement?: (node: HTMLElement | null) => void
  extraElements?: ItemListExtraElement[]
  filterTags?: (tag: string) => boolean
  getActionIcon?: (item: T) => ReactNode
  getChecked?: (item: T) => boolean
  getDescription?: (item: T) => string
  getForceFade?: (item: T) => boolean
  getHighlighted?: (item: T) => boolean
  getIcon?: (item: T) => ReactNode
  getTitle?: (item: T) => string
  groupsByMemberId?: ReadonlyMap<string, GroupItem[]>
  onCheck?: (item: T) => void
  onClick?: (item: T) => void
  onClickAction?: (item: T) => void
}

export function ItemListItem<T extends Item>(props: ItemListItemProps<T>) {
  const {
    index,
    style,
    item,
    itemsLength,
    measureElement,
    extraElements,
    filterTags,
    getActionIcon,
    getChecked,
    getDescription,
    getForceFade,
    getHighlighted,
    getIcon,
    getTitle,
    groupsByMemberId,
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

  const handleClick = useCallback(
    () => onClick?.(item),
    [item, onClick],
  )

  const handleClickAction = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation()
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
      index === itemsLength - 1
      && ((extraElements || [])
        .filter(e => e.index === -1 || e.index > index)
        .map(e => e.content))
    ),
    [extraElements, index, itemsLength],
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
                '&:hover': !onClickAction ? { backgroundColor: 'transparent' } : {},
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
