import makeStyles from '@material-ui/styles/makeStyles';
import { Container, IconButton, SwipeableDrawer, Theme, Toolbar, useMediaQuery } from '@material-ui/core';
import { createRef, KeyboardEvent, PropsWithChildren, useCallback, useEffect, useMemo } from 'react';
import { RemoveIcon } from '../Icons';
import DrawerActions, { Props as DrawerActionsProps } from './utils/DrawerActions';
import UnmountWatcher from './utils/UnmountWatcher';
import { usePage } from '../pages';
import { ItemId } from '../../state/items';
import { usePrevious } from '../../utils';


const useStyles = makeStyles(theme => ({
  root: {
    flexShrink: 0,
  },
  stacked: {},
  docked: {},
  drawerWidth: {
    width: '40vw',
    '&$stacked': {
      width: '35vw',
    },

    [theme.breakpoints.down('lg')]: {
      width: '70vw',
      '&$stacked': {
        width: '55vw',
      },
    },

    [theme.breakpoints.down('md')]: {
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
  drawerPaper: {
    backgroundColor: (
      theme.palette.mode === 'dark'
        ? theme.palette.background.default
        : theme.palette.background.paper
    ),
    backgroundImage: 'unset',

    // Docked (i.e. permanent) drawer should sit just below app bar
    '$docked &': {
      zIndex: theme.zIndex.appBar - 1,
    },
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
  typeIcon: {
    width: theme.spacing(6),
    height: theme.spacing(6),
    marginBottom: theme.spacing(1),
    opacity: 0.8,
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
  alwaysShowBack?: boolean,
  hideBackButton?: boolean,
  hideTypeIcon?: boolean,
  itemKey?: ItemId,
}
export type { BaseProps as BaseDrawerProps };
type Props = BaseProps & SpecificProps;


function BaseDrawer({
  ActionProps,
  alwaysShowBack = false,
  alwaysTemporary = false,
  children,
  hideBackButton = false,
  hideTypeIcon = false,
  itemKey,
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
  const paperClasses = [classes.drawerPaper, ...commonClasses];
  const xsScreen = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'));
  const largeScreen = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'));

  const page = usePage();

  const permanentDrawer = largeScreen && !stacked && !alwaysTemporary;
  const showBackButton = onBack && (
    alwaysShowBack || (
      !hideBackButton && (xsScreen || permanentDrawer)
    )
  );
  const showTypeIcon = !hideTypeIcon;

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
  const handleSave = useMemo(
    () => {
      if (ActionProps?.onSave) {
        return () => {
          ActionProps.onSave();
          if (!permanentDrawer) {
            onClose();
          }
        };
      }
      return undefined;
    },
    [ActionProps, onClose, permanentDrawer],
  );
  const modifiedActionProps = useMemo(
    () => ActionProps && ({
      ...ActionProps,
      onSave: handleSave,
    } as DrawerActionsProps),
    [ActionProps, handleSave],
  );

  const prevKey = usePrevious(itemKey);
  const containerRef = createRef<HTMLDivElement>();
  useEffect(
    () => {
      if (itemKey !== prevKey) {
        containerRef.current?.scrollTo(0, 0);
      }
    },
    [containerRef, itemKey, prevKey],
  );

  return (
    <SwipeableDrawer
      anchor="right"
      classes={{
        root: rootClasses.join(' '),
        paper: paperClasses.join(' '),
        docked: classes.docked,
      }}
      disableSwipeToOpen
      onClose={onClose}
      onOpen={() => {}}
      onKeyDown={handleKeyDown}
      open={open}
      sx={{
        zIndex: theme => (permanentDrawer ? theme.zIndex.appBar - 1 : undefined),
      }}
      SlideProps={{ onExited }}
      variant={permanentDrawer ? 'permanent' : 'temporary'}
    >
      <UnmountWatcher onUnmount={onUnmount} />

      {permanentDrawer && (
        <Toolbar />
      )}

      <div className={classes.layout}>
        <Container
          className={classes.container}
          data-cy="drawer-content"
          ref={containerRef}
        >
          <>
            {showTypeIcon && (
              <page.icon className={classes.typeIcon} />
            )}

            {showBackButton && (
              <div className={classes.backButton}>
                <IconButton data-cy="back-button" onClick={handleBack} size="large">
                  <RemoveIcon />
                </IconButton>
              </div>
            )}

            {children}
          </>
        </Container>

        {modifiedActionProps && (
          <div>
            <DrawerActions
              permanentDrawer={permanentDrawer}
              {...modifiedActionProps}
            />
          </div>
        )}
      </div>
    </SwipeableDrawer>
  );
}

export default BaseDrawer;
