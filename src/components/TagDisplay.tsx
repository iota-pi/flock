import { MouseEvent, useCallback } from 'react'
import { Box, Chip, Stack, styled, Typography } from '@mui/material'
import type { ItemId } from '../shared/itemTypes'
import { useUiStore } from '../state/uiStore'

const StyledChip = styled(Chip)(({ theme }) => ({
  marginTop: theme.spacing(0.5),
  marginBottom: theme.spacing(0.5),

  '& .MuiChip-label': {
    paddingLeft: theme.spacing(2),
    paddingRight: theme.spacing(2),
  },
}))

export interface Props {
  tags: string[],
  linkedIds?: ItemId[],
  max?: number,
  vertical?: boolean,
}

export interface TagChipProps {
  tag: string,
  linkedId?: ItemId,
}

function TagChip({
  tag,
  linkedId,
}: TagChipProps) {
  const replaceActive = useUiStore(state => state.replaceActive)

  const handleClick = useCallback(
    (event: MouseEvent) => {
      replaceActive({ item: linkedId })
      event.stopPropagation()
    },
    [linkedId, replaceActive],
  )

  return (
    <Box my={0.5}>
      <StyledChip
        data-cy="tag"
        label={tag}
        onClick={linkedId ? handleClick : undefined}
        variant="outlined"
        size="small"
      />
    </Box>
  )
}

function TagDisplay({
  tags,
  linkedIds,
  max,
  vertical = false,
}: Props) {
  const limitedTags = max && tags.length > max ? tags.slice(0, max - 1) : tags

  return (
    <Stack
      alignItems={vertical ? 'flex-start' : 'center'}
      direction={vertical ? 'column' : 'row'}
      spacing={1}
    >
      {limitedTags.map((tag, i) => (
        <TagChip
          linkedId={linkedIds?.[i]}
          key={tag}
          tag={tag}
        />
      ))}

      {limitedTags.length < tags.length && (
        <Box ml={limitedTags.length > 0 ? 0.5 : undefined}>
          <Typography
            color="text.secondary"
            data-cy="tag-overflow"
          >
            {limitedTags.length > 0 ? (
              `+${tags.length - limitedTags.length} more`
            ) : (
              `${tags.length} tags`
            )}
          </Typography>
        </Box>
      )}
    </Stack>
  )
}

export default TagDisplay
