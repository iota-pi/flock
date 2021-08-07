import React, { PropsWithChildren } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import DrawerDisplay from './DrawerDisplay';
import SelectedActions from '../SelectedActions';
import GeneralAlert from '../GeneralAlert';

const useStyles = makeStyles(() => ({
  root: {
    display: 'flex',
    flexGrow: 1,
    overflow: 'hidden',
  },
  layout: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    position: 'relative',
  },
  bottomDrawer: {
    flexShrink: 0,
    overflow: 'hidden',
  },
  pageContentHolder: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    overflowX: 'hidden',
    overflowY: 'hidden',
    position: 'relative',
  },
}));


function MainLayout({ children }: PropsWithChildren<{}>) {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      <div className={classes.layout}>
        <div className={classes.pageContentHolder}>
          {children}
        </div>

        <div className={classes.bottomDrawer}>
          <SelectedActions />
        </div>
      </div>

      <DrawerDisplay />

      <GeneralAlert />
    </div>
  );
}

export default MainLayout;
