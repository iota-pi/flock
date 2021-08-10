import React, { ReactNode } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab, Fade, LinearProgress } from '@material-ui/core';
import { AddIcon } from '../Icons';
import TopBar, { MenuItemData } from '../layout/TopBar';
import { useAppSelector } from '../../store';

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
    zIndex: theme.zIndex.speedDial,
  },
  loadingBarHolder: {
    position: 'relative',
  },
  loadingBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
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
  menuItems?: MenuItemData[],
  topBar: true,
}
interface NoTopBarProps {
  allSelected?: never,
  menuItems?: never,
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
  menuItems,
  onClickFab,
  onSelectAll,
  topBar,
}: Props) {
  const classes = useStyles();
  const activeRequests = useAppSelector(state => state.ui.requests.active);
  const loading = activeRequests > 0;

  return (
    <>
      {topBar && (
        <TopBar
          allSelected={allSelected}
          menuItems={menuItems || []}
          onSelectAll={onSelectAll}
        />
      )}

      <div className={classes.loadingBarHolder}>
        <Fade in={loading}>
          <LinearProgress className={classes.loadingBar} />
        </Fade>
      </div>

      <div
        className={classes.pageContent}
        data-cy="page-content"
      >
        {children}
      </div>

      {fab && (
        <div className={classes.fabContainer}>
          <Fab
            aria-label={fabLabel}
            data-cy="fab"
            color="secondary"
            onClick={onClickFab}
          >
            {fabIcon || <AddIcon />}
          </Fab>
        </div>
      )}
    </>
  );
}

export default BasePage;
