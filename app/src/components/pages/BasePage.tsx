import React, { ReactNode } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import { AddIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    flexGrow: 1,
  },
  pageContent: {
    position: 'relative',
    flexGrow: 1,
    paddingBottom: theme.spacing(8),
  },
  fabContainer: {
    position: 'absolute',
    // Width of FAB + spacing
    right: 56 + theme.spacing(3),
  },
  fab: {
    position: 'fixed',
    bottom: theme.spacing(3),
  },
}));

interface BaseProps {
  drawer?: ReactNode,
}
interface PropsWithFab extends BaseProps {
  fab: true,
  onClickFab: () => void,
  fabLabel: string,
  fabIcon?: ReactNode,
}
interface PropsWithoutFab extends BaseProps {
  fab?: false,
  onClickFab?: never,
  fabIcon?: never,
  fabLabel?: never,
}
type CombinedProps = PropsWithFab | PropsWithoutFab;
type Props = React.PropsWithChildren<CombinedProps>;
export type { Props as BasePageProps };


function BasePage({
  children,
  drawer = null,
  fab,
  fabIcon,
  fabLabel,
  onClickFab,
}: Props) {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      <div className={classes.pageContent}>
        {children}

        {fab && (
          <div className={classes.fabContainer}>
            <Fab
              onClick={onClickFab}
              color="secondary"
              aria-label={fabLabel}
              className={classes.fab}
            >
              {fabIcon || <AddIcon />}
            </Fab>
          </div>
        )}
      </div>

      {drawer}
    </div>
  );
}

export default BasePage;
