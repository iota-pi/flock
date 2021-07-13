import React, { KeyboardEvent, PropsWithChildren, ReactNode, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, IconButton, SwipeableDrawer, Theme, Toolbar, useMediaQuery } from '@material-ui/core';
import { BackIcon } from '../Icons';
import DrawerActions, { Props as DrawerActionsProps } from './utils/DrawerActions';


const useStyles = makeStyles(theme => ({
  root: {
    flexShrink: 0,
  },
  stacked: {},
  drawerWidth: {
    width: '45vw',
    '&$stacked': {
      width: '35vw',
    },

    [theme.breakpoints.down('md')]: {
      width: '70vw',
      '&$stacked': {
        width: '55vw',
      },
    },

    [theme.breakpoints.down('sm')]: {
      width: '85vw',
      '&$stacked': {
        width: '70vw',
      },
    },

    [theme.breakpoints.only('xs')]: {
      width: '100vw',
      '&$stacked': {
        width: '100vw',
      },
    },
  },
  defaultBackground: {
    backgroundColor: theme.palette.background.default,
  },
  layout: {
    display: 'flex',
    flexGrow: 1,
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
  showCancelDelete?: boolean,
  stacked?: boolean,
}
interface SpecificProps {
  ActionProps?: DrawerActionsProps,
  hideBackButton?: boolean,
  placeholder?: ReactNode,
}
export type { BaseProps as ItemDrawerProps };
type Props = BaseProps & SpecificProps;


function BaseDrawer({
  ActionProps,
  children,
  hideBackButton = false,
  onBack,
  onClose,
  open,
  placeholder = null,
  stacked,
}: PropsWithChildren<Props>) {
  const classes = useStyles();
  const commonClasses = [classes.drawerWidth];
  if (stacked) commonClasses.push(classes.stacked);
  const rootClasses = [classes.root, ...commonClasses];
  const paperClasses = [classes.defaultBackground, ...commonClasses];
  const largeScreen = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'));

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

  const permanentDrawer = largeScreen && !stacked;
  const showBackButton = !hideBackButton && !permanentDrawer;

  return (
    <SwipeableDrawer
      className={rootClasses.join(' ')}
      variant={permanentDrawer ? 'permanent' : 'temporary'}
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
      {permanentDrawer && (
        <Toolbar />
      )}

      <div className={classes.layout}>
        <Container className={classes.container}>
          <>
            {showBackButton && (
              <div className={classes.backButton}>
                <IconButton onClick={handleBack}>
                  <BackIcon />
                </IconButton>
              </div>
            )}

            {!open ? placeholder : children}
          </>
        </Container>

        {ActionProps && (open || !permanentDrawer) && (
          <div>
            <DrawerActions {...ActionProps} />
          </div>
        )}
      </div>
    </SwipeableDrawer>
  );
}

export default BaseDrawer;
