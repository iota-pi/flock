import { MouseEvent, useCallback } from 'react'
import { Box, Chip, Stack, styled, Typography } from '@mui/material'
import { setTagFilter } from '../state/ui'
import { useAppDispatch } from '../store'

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
  linked?: boolean,
  max?: number,
  vertical?: boolean,
}

export interface TagChipProps {
  tag: string,
  linked: boolean,
}

function TagChip({
  tag,
  linked,
}: TagChipProps) {
  const dispatch = useAppDispatch()

  const handleClick = useCallback(
    (event: MouseEvent) => {
      dispatch(setTagFilter(tag))
      event.stopPropagation()
    },
    [dispatch, tag],
  )

  return (
    <Box my={0.5}>
      <StyledChip
        data-cy="tag"
        label={tag}
        onClick={linked ? handleClick : undefined}
        variant="outlined"
      />
    </Box>
  )
}

function TagDisplay({
  tags,
  linked = false,
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
      {limitedTags.map(tag => (
        <TagChip
          linked={linked}
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
