import { PropsWithChildren, ReactNode } from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import { Fab, Fade, LinearProgress, styled } from '@material-ui/core';
import { AddIcon } from '../Icons';
import TopBar, { MenuItemData } from '../layout/TopBar';
import { useAppSelector } from '../../store';

const useStyles = makeStyles(theme => ({
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
  noScrollContainer?: boolean,
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
  sortable?: boolean,
  topBarTitle?: string,
  topBar: true,
}
interface NoTopBarProps {
  allSelected?: never,
  menuItems?: never,
  onSelectAll?: never,
  sortable?: never,
  topBar?: false,
  topBarTitle?: never,
}
type CombinedProps = BaseProps & (FabProps | NoFabProps) & (TopBarProps | NoTopBarProps);
type Props = PropsWithChildren<CombinedProps>;
export type { Props as BasePageProps };


const ContentWithScroll = styled('div')(({ theme }) => ({
  position: 'relative',
  flexGrow: 1,
  paddingBottom: theme.spacing(8),
  overflowX: 'hidden',
  overflowY: 'auto',
}));
const ContentNoScroll = styled('div')({
  position: 'relative',
  flexGrow: 1,
  overflowX: 'hidden',
  overflowY: 'hidden',
});


function BasePage({
  allSelected,
  children,
  fab,
  fabIcon,
  fabLabel,
  menuItems,
  onClickFab,
  onSelectAll,
  noScrollContainer,
  sortable,
  topBar,
  topBarTitle,
}: Props) {
  const classes = useStyles();
  const activeRequests = useAppSelector(state => state.ui.requests.active);
  const loading = activeRequests > 0;

  const ContentElement = noScrollContainer ? ContentNoScroll : ContentWithScroll;

  return (
    <>
      {topBar && (
        <TopBar
          allSelected={allSelected}
          menuItems={menuItems || []}
          onSelectAll={onSelectAll}
          sortable={sortable}
          title={topBarTitle}
        />
      )}

      <div className={classes.loadingBarHolder}>
        <Fade in={loading}>
          <LinearProgress className={classes.loadingBar} />
        </Fade>
      </div>

      <ContentElement data-cy="page-content">
        {children}
      </ContentElement>

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
