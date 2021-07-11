import React, { KeyboardEvent, PropsWithChildren, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, IconButton, SwipeableDrawer } from '@material-ui/core';
import { BackIcon } from '../Icons';
import DrawerActions, { Props as DrawerActionsProps } from './utils/DrawerActions';


const useStyles = makeStyles(theme => ({
  root: {
    flexShrink: 0,
  },
  stacked: {},
  drawerWidth: {
    width: '60%',
    '&$stacked': {
      width: '45%',
    },

    [theme.breakpoints.down('md')]: {
      width: '80%',
      '&$stacked': {
        width: '60%',
      },
    },

    [theme.breakpoints.only('xs')]: {
      width: '100%',
      '&$stacked': {
        width: '100%',
      },
    },
  },
  defaultBackground: {
    backgroundColor: theme.palette.background.default,
  },
  layout: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  container: {
    position: 'relative',
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  backButton: {
    position: 'absolute',
    display: 'flex',
    top: theme.spacing(2),
    right: theme.spacing(2),
  },
}));

interface BaseProps {
  onBack?: () => void,
  onClose: () => void,
  open: boolean,
  stacked?: boolean,
  showCancelDelete?: boolean,
  onNext?: () => void,
}
interface SpecificProps {
  ActionProps?: DrawerActionsProps,
}
export type { BaseProps as ItemDrawerProps };
type Props = BaseProps & SpecificProps;


function BaseDrawer({
  ActionProps,
  children,
  onBack,
  onClose,
  open,
  stacked,
}: PropsWithChildren<Props>) {
  const classes = useStyles();
  const commonClasses = [classes.drawerWidth];
  if (stacked) commonClasses.push(classes.stacked);
  const rootClasses = [classes.root, ...commonClasses];
  const paperClasses = [classes.defaultBackground, ...commonClasses];

  const handleBack = useCallback(
    () => {
      if (onBack) {
        onBack();
      } else {
        onClose();
      }
    },
    [onBack, onClose],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'Enter') {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <SwipeableDrawer
      className={rootClasses.join(' ')}
      variant="temporary"
      open={open}
      onClose={onClose}
      onOpen={() => {}}
      disableSwipeToOpen
      anchor="right"
      classes={{
        paper: paperClasses.join(' '),
      }}
      onKeyDown={handleKeyDown}
    >
      <div className={classes.layout}>
        <Container className={classes.container}>
          <>
            <div className={classes.backButton}>
              <IconButton onClick={handleBack}>
                <BackIcon />
              </IconButton>
            </div>

            {children}
          </>
        </Container>

        {ActionProps && (
          <div>
            <DrawerActions {...ActionProps} />
          </div>
        )}
      </div>
    </SwipeableDrawer>
  );
}

export default BaseDrawer;
