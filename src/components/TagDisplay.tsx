import {
  memo,
  type CSSProperties,
  type MouseEvent,
  useCallback,
  useMemo,
} from 'react'
import { useTheme } from '@mui/material/styles'
import type { ItemId } from '../shared/itemTypes'
import { useNavigationStore } from '../state/navigationStore'

const CHIP_BASE_STYLE: CSSProperties = {
  alignItems: 'center',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderRadius: '16px',
  display: 'inline-flex',
  fontSize: '0.8125rem',
  fontWeight: 400,
  justifyContent: 'center',
  lineHeight: 1.4,
  maxWidth: '100%',
  minHeight: '24px',
  padding: '0 10px',
  whiteSpace: 'nowrap',
}

const CHIP_BUTTON_STYLE: CSSProperties = {
  ...CHIP_BASE_STYLE,
  appearance: 'none',
  background: 'transparent',
  cursor: 'pointer',
  outline: 'none',
}

const CHIP_STATIC_STYLE: CSSProperties = {
  ...CHIP_BASE_STYLE,
  cursor: 'default',
}

const CONTAINER_HORIZONTAL_STYLE: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexDirection: 'row',
  gap: '8px',
}

const CONTAINER_VERTICAL_STYLE: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

const OVERFLOW_TEXT_BASE_STYLE: CSSProperties = {
  fontSize: '0.875rem',
  lineHeight: 1.43,
}

interface Props {
  tags: string[],
  linkedIds?: ItemId[],
  max?: number,
  vertical?: boolean,
}

interface TagChipProps {
  tag: string,
  linkedId?: ItemId,
  chipButtonStyle: CSSProperties,
  chipStaticStyle: CSSProperties,
  onLinkedTagClick: (event: MouseEvent<HTMLButtonElement>, linkedId: ItemId) => void,
}

const TagChip = memo(function TagChip({
  tag,
  linkedId,
  chipButtonStyle,
  chipStaticStyle,
  onLinkedTagClick,
}: TagChipProps) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!linkedId) {
        return
      }

      onLinkedTagClick(event, linkedId)
    },
    [linkedId, onLinkedTagClick],
  )

  if (!linkedId) {
    return (
      <span
        data-cy="tag"
        style={chipStaticStyle}
      >
        {tag}
      </span>
    )
  }

  return (
    <button
      type="button"
      data-cy="tag"
      onClick={handleClick}
      style={chipButtonStyle}
      aria-label={`Open related item ${tag}`}
    >
      {tag}
    </button>
  )
})

TagChip.displayName = 'TagChip'

function TagDisplay({
  tags,
  linkedIds,
  max,
  vertical = false,
}: Props) {
  const theme = useTheme()
  const setDrawer = useNavigationStore(state => state.setDrawer)
  const limitedTags = useMemo(
    () => (max && tags.length > max ? tags.slice(0, max - 1) : tags),
    [max, tags],
  )
  const chipButtonStyle = useMemo(
    () => ({
      ...CHIP_BUTTON_STYLE,
      borderColor: theme.palette.divider,
      color: theme.palette.text.primary,
    }),
    [theme.palette.divider, theme.palette.text.primary],
  )
  const chipStaticStyle = useMemo(
    () => ({
      ...CHIP_STATIC_STYLE,
      borderColor: theme.palette.divider,
      color: theme.palette.text.primary,
    }),
    [theme.palette.divider, theme.palette.text.primary],
  )
  const overflowTextStyle = useMemo(
    () => ({
      ...OVERFLOW_TEXT_BASE_STYLE,
      color: theme.palette.text.secondary,
    }),
    [theme.palette.text.secondary],
  )
  const overflowTextWithMarginStyle = useMemo(
    () => ({
      ...overflowTextStyle,
      marginLeft: 4,
    }),
    [overflowTextStyle],
  )
  const handleLinkedTagClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, linkedId: ItemId) => {
      setDrawer({ item: linkedId })
      event.stopPropagation()
    },
    [setDrawer],
  )
  const containerStyle = vertical
    ? CONTAINER_VERTICAL_STYLE
    : CONTAINER_HORIZONTAL_STYLE
  const overflowStyle = limitedTags.length > 0
    ? overflowTextWithMarginStyle
    : overflowTextStyle

  return (
    <div style={containerStyle}>
      {limitedTags.map((tag, i) => (
        <TagChip
          chipButtonStyle={chipButtonStyle}
          chipStaticStyle={chipStaticStyle}
          linkedId={linkedIds?.[i]}
          key={`${tag}-${i}`}
          tag={tag}
          onLinkedTagClick={handleLinkedTagClick}
        />
      ))}

      {limitedTags.length < tags.length && (
        <span
          data-cy="tag-overflow"
          style={overflowStyle}
        >
          {limitedTags.length > 0 ? (
            `+${tags.length - limitedTags.length} more`
          ) : (
            `${tags.length} tags`
          )}
        </span>
      )}
    </div>
  )
}

export default memo(TagDisplay)
