import React, { ReactNode } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import { AddIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  root: {
    position: 'relative',
    flexGrow: 1,
    marginBottom: theme.spacing(8),
  },
  fab: {
    position: 'fixed',
    bottom: theme.spacing(3),
    right: theme.spacing(3),
  },
}));

interface BaseProps {
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
  fab,
  fabIcon,
  fabLabel,
  onClickFab,
}: Props) {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      {children}

      {fab && (
        <Fab
          onClick={onClickFab}
          color="secondary"
          aria-label={fabLabel}
          className={classes.fab}
        >
          {fabIcon || <AddIcon />}
        </Fab>
      )}
    </div>
  );
}

export default BasePage;
