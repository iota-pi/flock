import React, { useCallback, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { fade } from '@material-ui/core';
import { Item } from '../../state/items';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import DrawerActions from './utils/DrawerActions';
import AnyItemDrawer from './AnyItemDrawer';


const useStyles = makeStyles(theme => ({
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  filler: {
    flexGrow: 1,
  },
  danger: {
    borderColor: theme.palette.error.light,
    color: theme.palette.error.light,

    '&:hover': {
      backgroundColor: fade(theme.palette.error.light, 0.08),
    },
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props extends ItemDrawerProps {
  canEdit?: boolean,
  item: Item,
}


function ReportDrawer({
  canEdit = false,
  item,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();

  const [editing, setEditing] = useState(false);
  const handleEdit = useCallback(() => setEditing(true), []);
  const handleBack = useCallback(() => setEditing(false), []);
  const handleClose = useCallback(
    () => {
      setEditing(false);
      onClose();
    },
    [onClose],
  );

  return (
    <>
      <BaseDrawer
        open={open}
        onClose={handleClose}
        stacked={stacked}
      >
        <ItemReport
          item={item}
          canEdit={canEdit}
          onEdit={handleEdit}
        />

        <div className={classes.filler} />

        <DrawerActions
          item={item}
          onDone={handleClose}
        />
      </BaseDrawer>

      {canEdit && (
        <AnyItemDrawer
          item={item}
          onBack={handleBack}
          onClose={handleClose}
          stacked={stacked}
          open={editing}
        />
      )}
    </>
  );
}

export default ReportDrawer;
