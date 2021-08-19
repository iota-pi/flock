import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import DateFnsUtils from '@date-io/date-fns';
import { Toolbar, useMediaQuery } from '@material-ui/core';
import { makeStyles, Theme } from '@material-ui/core/styles';
import { MuiPickersUtilsProvider } from '@material-ui/pickers';
import AppBar from './components/layout/AppBar';
import MainMenu from './components/layout/MainMenu';
import PageView from './components/pages';
import { useAppDispatch } from './store';
import { loadVault } from './state/vault';
import { useVault } from './state/selectors';
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
  const vault = useVault();
  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'));

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
      <MuiPickersUtilsProvider utils={DateFnsUtils}>
        <Router>
          <div className={classes.root}>
            <AppBar
              minimisedMenu={miniMenu}
              onMinimiseMenu={handleShowMenu}
            />

            <MainMenu open minimised={miniMenu} />

            <div className={classes.content}>
              <Toolbar />

              <MainLayout>
                <PageView />
              </MainLayout>
            </div>
          </div>
        </Router>
      </MuiPickersUtilsProvider>
    </>
  );
}
