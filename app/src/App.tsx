import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { Toolbar, useMediaQuery } from '@material-ui/core';
import { Theme } from '@material-ui/core/styles';
import AdapterDateFns from '@material-ui/lab/AdapterDateFns';
import LocalizationProvider from '@material-ui/lab/LocalizationProvider';
import makeStyles from '@material-ui/styles/makeStyles';
import AppBar from './components/layout/AppBar';
import MainMenu from './components/layout/MainMenu';
import PageView from './components/pages';
import { useAppDispatch } from './store';
import { loadVault } from './state/vault';
import { useLoggedIn, useVault } from './state/selectors';
import migrateItems from './state/migrations';
import Vault from './crypto/Vault';
import MainLayout from './components/layout/MainLayout';


const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    height: '100vh',
  },
  section: {
    paddingTop: theme.spacing(4),
    paddingBottom: theme.spacing(4),
  },
  paddingTop: {
    paddingTop: theme.spacing(2),
  },
  content: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
}));

async function initialLoadFromVault(vault: Vault) {
  const accountDataPromise = vault.getMetadata();
  const itemsPromise = vault.fetchAll();
  await accountDataPromise;
  const items = await itemsPromise;
  await migrateItems(items);
}

export default function App() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const loggedIn = useLoggedIn();
  const vault = useVault();
  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'));

  const [rawMiniMenu, setMiniMenu] = useState<boolean>();
  const miniMenu = rawMiniMenu === undefined ? sm : rawMiniMenu;

  const handleShowMenu = useCallback(
    () => {
      setMiniMenu(!miniMenu);
    },
    [miniMenu],
  );

  useEffect(
    () => {
      if (vault) {
        initialLoadFromVault(vault);
      }
    },
    [vault],
  );

  const restoreVaultFromStorage = useCallback(
    () => loadVault(dispatch),
    [dispatch],
  );

  useEffect(() => { restoreVaultFromStorage(); }, [restoreVaultFromStorage]);

  return (
    <>
      <LocalizationProvider dateAdapter={AdapterDateFns}>
        <Router>
          <div className={classes.root}>
            {loggedIn && (
              <>
                <AppBar
                  minimisedMenu={miniMenu}
                  onMinimiseMenu={handleShowMenu}
                />
                <MainMenu open minimised={miniMenu} />
              </>
            )}

            <div className={classes.content}>
              {loggedIn && (
                <Toolbar />
              )}

              <MainLayout>
                <PageView />
              </MainLayout>
            </div>
          </div>
        </Router>
      </LocalizationProvider>
    </>
  );
}
