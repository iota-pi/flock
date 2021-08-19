import { KeyboardEvent, PropsWithChildren, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, IconButton, SwipeableDrawer, Theme, Toolbar, useMediaQuery } from '@material-ui/core';
import { BackIcon, RemoveIcon } from '../Icons';
import DrawerActions, { Props as DrawerActionsProps } from './utils/DrawerActions';
import UnmountWatcher from './utils/UnmountWrapper';


const useStyles = makeStyles(theme => ({
  root: {
    flexShrink: 0,
  },
  stacked: {},
  drawerWidth: {
    width: '40vw',
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
  onExited?: () => void,
  onUnmount?: () => void,
  open: boolean,
  stacked?: boolean,
  alwaysTemporary?: boolean,
}
interface SpecificProps {
  ActionProps?: DrawerActionsProps,
  hideBackButton?: boolean,
}
export type { BaseProps as BaseDrawerProps };
type Props = BaseProps & SpecificProps;


function BaseDrawer({
  ActionProps,
  alwaysTemporary = false,
  children,
  hideBackButton = false,
  onBack,
  onClose,
  onExited,
  onUnmount,
  open,
  stacked,
}: PropsWithChildren<Props>) {
  const classes = useStyles();
  const commonClasses = [classes.drawerWidth];
  if (stacked) commonClasses.push(classes.stacked);
  const rootClasses = [classes.root, ...commonClasses];
  const paperClasses = [classes.defaultBackground, ...commonClasses];
  const xsScreen = useMediaQuery<Theme>(theme => theme.breakpoints.down('xs'));
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

  const permanentDrawer = largeScreen && !stacked && !alwaysTemporary;
  const showBackButton = !hideBackButton && onBack && (xsScreen || permanentDrawer);
  const BackButtonIcon = permanentDrawer ? RemoveIcon : BackIcon;

  return (
    <SwipeableDrawer
      className={rootClasses.join(' ')}
      variant={permanentDrawer ? 'permanent' : 'temporary'}
      SlideProps={{ onExited }}
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
      <UnmountWatcher onUnmount={onUnmount} />

      {permanentDrawer && (
        <Toolbar />
      )}

      <div className={classes.layout}>
        <Container
          className={classes.container}
          data-cy="drawer-content"
        >
          <>
            {showBackButton && (
              <div className={classes.backButton}>
                <IconButton onClick={handleBack}>
                  <BackButtonIcon />
                </IconButton>
              </div>
            )}

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
