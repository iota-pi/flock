import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { Toolbar, useMediaQuery } from '@mui/material';
import { Theme } from '@mui/material/styles';
import AdapterDateFns from '@mui/lab/AdapterDateFns';
import LocalizationProvider from '@mui/lab/LocalizationProvider';
import makeStyles from '@mui/styles/makeStyles';
import AppBar from './components/layout/AppBar';
import MainMenu from './components/layout/MainMenu';
import PageView from './components/pages';
import { useAppDispatch } from './store';
import { loadVault } from './state/vault';
import { useLoggedIn, useVault } from './state/selectors';
import migrateItems from './state/migrations';
import Vault from './api/Vault';
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
  content: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
}));

async function initialLoadFromVault(vault: Vault) {
  const accountDataPromise = vault.getMetadata();
  const itemsPromise = vault.fetchAll();
  const messagesPromise = vault.koinonia.listMessages().catch(
    error => console.warn('Failed to get messages', error),
  );

  // Note: account metadata needs to be available before migrating items
  await accountDataPromise;

  const items = await itemsPromise;
  await migrateItems(items);

  await messagesPromise;
}

export default function App() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const loggedIn = useLoggedIn();
  const vault = useVault();
  const small = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'));
  const xs = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'));

  const [rawMiniMenu, setMiniMenu] = useState<boolean>();
  const [rawOpenMenu, setOpenMenu] = useState<boolean>();
  const defaultMini = small;
  const defaultOpen = !xs;
  const miniMenu = rawMiniMenu === undefined ? defaultMini : rawMiniMenu;
  const openMenu = rawOpenMenu === undefined ? defaultOpen : rawOpenMenu;

  const handleToggleMiniMenu = useCallback(
    () => setMiniMenu(m => (
      m !== undefined && miniMenu !== defaultMini ? undefined : !miniMenu
    )),
    [defaultMini, miniMenu],
  );
  const handleToggleShowMenu = useCallback(
    () => setOpenMenu(o => (
      o !== undefined && openMenu !== defaultOpen ? undefined : !openMenu
    )),
    [defaultOpen, openMenu],
  );
  const handleMenuClick = useCallback(
    () => {
      if (xs) {
        setOpenMenu(undefined);
      }
    },
    [xs],
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
                  onToggleMenu={handleToggleShowMenu}
                />
                <MainMenu
                  minimised={miniMenu}
                  open={openMenu}
                  onClick={handleMenuClick}
                  onMinimise={handleToggleMiniMenu}
                />
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
