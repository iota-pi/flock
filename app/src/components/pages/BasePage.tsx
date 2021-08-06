import React, { ReactNode } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import { AddIcon } from '../Icons';
import TopBar from '../nav/TopBar';

const useStyles = makeStyles(theme => ({
  pageContent: {
    position: 'relative',
    flexGrow: 1,
    paddingBottom: theme.spacing(8),
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  fabContainer: {
    position: 'absolute',
    right: theme.spacing(4),
    bottom: theme.spacing(3),
  },
}));

interface BaseProps {
  drawer?: ReactNode,
}
interface FabProps {
  fab: true,
  onClickFab: () => void,
  fabIcon?: ReactNode,
  fabLabel: string,
}
interface NoFabProps {
  fab?: false,
  onClickFab?: never,
  fabIcon?: never,
  fabLabel?: never,
}
interface TopBarProps {
  allSelected?: boolean,
  onSelectAll?: () => void,
  topBar: true,
}
interface NoTopBarProps {
  allSelected?: never,
  onSelectAll?: never,
  topBar?: false,
}
type CombinedProps = BaseProps & (FabProps | NoFabProps) & (TopBarProps | NoTopBarProps);
type Props = React.PropsWithChildren<CombinedProps>;
export type { Props as BasePageProps };


function BasePage({
  allSelected,
  children,
  fab,
  fabIcon,
  fabLabel,
  onClickFab,
  onSelectAll,
  topBar,
}: Props) {
  const classes = useStyles();

  return (
    <>
      {topBar && (
        <TopBar
          allSelected={allSelected}
          onSelectAll={onSelectAll}
        />
      )}

      <div className={classes.pageContent}>
        {children}
      </div>

      {fab && (
        <div className={classes.fabContainer}>
          <Fab
            onClick={onClickFab}
            color="secondary"
            aria-label={fabLabel}
          >
            {fabIcon || <AddIcon />}
          </Fab>
        </div>
      )}
    </>
  );
}

export default BasePage;
