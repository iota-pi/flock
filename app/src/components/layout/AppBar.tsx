import {
  AppBar as MuiAppBar,
  Box,
  IconButton,
  styled,
  Theme,
  ThemeProvider,
  Toolbar,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { APP_NAME } from '../../utils';
import { dark as darkTheme } from '../../theme';
import EverythingSearch from './EverythingSearch';
import { DRAWER_SPACING_FULL, DRAWER_SPACING_NARROW } from './MainMenu';
import { MenuIcon } from '../Icons';

const StyledToolbar = styled(Toolbar)(({ theme }) => ({
  paddingLeft: theme.spacing(3),
  paddingRight: 0,

  [theme.breakpoints.down('sm')]: {
    paddingRight: theme.spacing(1),
  },
}));
const SearchHolder = styled('div')(({ theme }) => ({
  flexGrow: 1,
  marginLeft: theme.spacing(1),
  marginRight: theme.spacing(1),

  [theme.breakpoints.down('sm')]: {
    marginLeft: 0,
    marginRight: 0,
  },
}));
const PreSearchContent = styled(
  'div',
  {
    shouldForwardProp: p => p !== 'minimised',
  },
)<{ minimised: boolean }>(({ minimised, theme }) => ({
  display: 'flex',
  alignItems: 'center',
  minWidth: theme.spacing(
    (minimised ? DRAWER_SPACING_NARROW : DRAWER_SPACING_FULL) - 3,
  ),
  paddingLeft: theme.spacing(0.5),
  paddingRight: theme.spacing(3.5),
  transition: theme.transitions.create(['padding', 'min-width']),

  [theme.breakpoints.down('sm')]: {
    minWidth: theme.spacing(DRAWER_SPACING_NARROW - 3),
    paddingRight: 0,
  },
}));

export interface Props {
  minimisedMenu: boolean,
  onToggleMenu: () => void,
}


function AppBar({
  minimisedMenu,
  onToggleMenu,
}: Props) {
  const showAppTitle = useMediaQuery<Theme>(theme => theme.breakpoints.up('sm'));

  return (
    <MuiAppBar
      enableColorOnDark
      position="fixed"
    >
      <StyledToolbar>
        <PreSearchContent minimised={minimisedMenu}>
          <Box mr={2}>
            <IconButton
              edge="start"
              color="inherit"
              aria-label="menu"
              onClick={onToggleMenu}
              size="large"
            >
              <MenuIcon />
            </IconButton>
          </Box>

          {showAppTitle && (
            <Typography variant="h6" color="inherit">
              {APP_NAME}
            </Typography>
          )}
        </PreSearchContent>

        <SearchHolder>
          <ThemeProvider theme={darkTheme}>
            <EverythingSearch label="Search" />
          </ThemeProvider>
        </SearchHolder>
      </StyledToolbar>
    </MuiAppBar>
  );
}

export default AppBar;
