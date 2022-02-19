import { memo, useEffect, useRef } from 'react';
import { Alert, Typography } from '@mui/material';
import { getItemTypeLabel, ItemType } from '../../../state/items';
import { useStyles } from '../ItemDrawer';

const DuplicateAlert = memo(({
  count, hasDescription, itemType,
}: {
  count: number;
  hasDescription: boolean;
  itemType: ItemType;
}) => {
  const classes = useStyles();
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
    <Alert
      className={classes.alert}
      severity={hasDescription ? 'info' : 'warning'}
    >
      <Typography paragraph={!hasDescription}>
        There {areOrIs} <span className={classes.emphasis}>{displayCount}</span>
        {' other '}
        {getItemTypeLabel(itemType, plural).toLowerCase()}
        {' with this name.'}
      </Typography>

      {!hasDescription && (
        <Typography>
          Please check if this is a duplicate.
          Otherwise, it may be helpful to
          {' '}
          <span className={classes.emphasis}>add a description</span>
          {' '}
          to help distinguish between these {getItemTypeLabel(itemType, true).toLowerCase()}.
        </Typography>
      )}
    </Alert>
  );
});
DuplicateAlert.displayName = 'DuplicateAlert';

export default DuplicateAlert;
