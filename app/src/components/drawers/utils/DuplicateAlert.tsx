import { memo, useEffect, useRef } from 'react';
import { Alert, styled, Typography } from '@mui/material';
import { getItemTypeLabel, ItemType } from '../../../state/items';
import InlineText from '../../InlineText';

const StyledAlert = styled(Alert)(({ theme }) => ({
  transition: theme.transitions.create('all'),
  marginTop: theme.spacing(1),
}));


const DuplicateAlert = memo(({
  count, hasDescription, itemType,
}: {
  count: number;
  hasDescription: boolean;
  itemType: ItemType;
}) => {
  const ref = useRef<number>(1);
  useEffect(() => {
    if (count > 0) {
      ref.current = count;
    }
  });
  const displayCount = count || ref.current;

  const plural = displayCount !== 1;
  const areOrIs = plural ? 'are' : 'is';

  return (
    <StyledAlert
      severity={hasDescription ? 'info' : 'warning'}
    >
      <Typography paragraph={!hasDescription}>
        There {areOrIs} <InlineText fontWeight={500}>{displayCount}</InlineText>
        {' other '}
        {getItemTypeLabel(itemType, plural).toLowerCase()}
        {' with this name.'}
      </Typography>

      {!hasDescription && (
        <Typography>
          Please check if this is a duplicate.
          Otherwise, it may be helpful to
          {' '}
          <InlineText fontWeight={500}>add a description</InlineText>
          {' '}
          to help distinguish between these {getItemTypeLabel(itemType, true).toLowerCase()}.
        </Typography>
      )}
    </StyledAlert>
  );
});
DuplicateAlert.displayName = 'DuplicateAlert';

export default DuplicateAlert;
