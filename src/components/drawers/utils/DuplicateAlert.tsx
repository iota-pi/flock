import { memo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'
import { styled } from '@mui/material/styles'

import { getItemTypeLabel } from 'src/state/items'
import type { ItemType } from 'src/shared/itemTypes'
import InlineText from '../../ui/InlineText'

const StyledAlert = styled(Alert)(({ theme }) => ({
  transition: theme.transitions.create('all'),
  marginTop: theme.spacing(1),
}))


const DuplicateAlert = memo(({
  count, hasDescription, itemType,
}: {
  count: number;
  hasDescription: boolean;
  itemType: ItemType;
}) => {
  const [lastNonZeroCount, setLastNonZeroCount] = useState(1)
  if (count > 0 && count !== lastNonZeroCount) {
    setLastNonZeroCount(count)
  }
  const displayCount = count || lastNonZeroCount

  const plural = displayCount !== 1
  const areOrIs = plural ? 'are' : 'is'

  return (
    <StyledAlert
      severity={hasDescription ? 'info' : 'warning'}
    >
      <Typography>
        There {areOrIs} <InlineText>{displayCount}</InlineText>
        {' other '}
        {getItemTypeLabel(itemType, plural).toLowerCase()}
        {' with this name.'}
      </Typography>

      {!hasDescription && (
        <Typography>
          Please check if this is a duplicate.
          Otherwise, it may be helpful to
          {' '}
          <InlineText>add a description</InlineText>
          {' '}
          to help distinguish between these {getItemTypeLabel(itemType, true).toLowerCase()}.
        </Typography>
      )}
    </StyledAlert>
  )
})
DuplicateAlert.displayName = 'DuplicateAlert'

export default DuplicateAlert
