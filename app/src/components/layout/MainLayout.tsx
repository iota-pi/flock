import { PropsWithChildren } from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import DrawerDisplay from './DrawerDisplay';
import SelectedActions from '../SelectedActions';
import GeneralMessage from '../GeneralMessage';
import { useLoggedIn } from '../../state/selectors';

const useStyles = makeStyles(() => ({
  root: {
    display: 'flex',
    flexGrow: 1,
    overflow: 'hidden',
  },
  layout: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    position: 'relative',
  },
  bottomDrawer: {
    flexShrink: 0,
    overflow: 'hidden',
  },
  pageContentHolder: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    overflowX: 'hidden',
    overflowY: 'hidden',
    position: 'relative',
  },
}));


function MainLayout({ children }: PropsWithChildren<{}>) {
  const classes = useStyles();
  const loggedIn = useLoggedIn();

  return (
    <div className={classes.root}>
      <div className={classes.layout}>
        <div className={classes.pageContentHolder}>
          {children}
        </div>

        <div className={classes.bottomDrawer}>
          <SelectedActions />
        </div>
      </div>

      {loggedIn && (
        <DrawerDisplay />
      )}

      <GeneralMessage />
    </div>
  );
}

export default MainLayout;
