import React, { KeyboardEvent, PropsWithChildren, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, Drawer, IconButton } from '@material-ui/core';
import { BackIcon } from '../Icons';


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
  container: {
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
    right: theme.spacing(3),
  },
}));

interface Props {
  onBack?: () => void,
  onClose: () => void,
  open: boolean,
  stacked?: boolean,
  showCancelDelete?: boolean,
  onNext?: () => void,
}
export type { Props as ItemDrawerProps };


function BaseDrawer({
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
    <Drawer
      className={rootClasses.join(' ')}
      variant="temporary"
      open={open}
      onClose={onClose}
      anchor="right"
      classes={{
        paper: paperClasses.join(' '),
      }}
      onKeyDown={handleKeyDown}
    >
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
    </Drawer>
  );
}

export default BaseDrawer;
