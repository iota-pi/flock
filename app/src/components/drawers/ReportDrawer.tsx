import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Container,
  fade,
} from '@material-ui/core';
import { Item } from '../../state/items';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import DrawerActions from '../DrawerActions';


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
  item: Item,
}


function GroupReportDrawer({
  item,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();

  return (
    <>
      <BaseDrawer
        open={open}
        onClose={onClose}
        stacked={stacked}
      >
        <Container className={classes.drawerContainer}>
          <ItemReport item={item} />

          <div className={classes.filler} />

          <DrawerActions
            item={item}
            onDone={onClose}
          />
        </Container>
      </BaseDrawer>
    </>
  );
}

export default GroupReportDrawer;
