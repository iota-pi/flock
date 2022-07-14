import { red, teal, yellow } from '@mui/material/colors';
import { createTheme } from '@mui/material';

export const dark = createTheme({
  palette: {
    primary: {
      main: teal[600],
    },
    secondary: {
      main: yellow[700],
    },
    error: {
      main: '#ff4569',
    },
    background: {
      default: '#202020',
      paper: '#202020',
    },
    mode: 'dark',
  },
});
export const light = createTheme({
  palette: {
    primary: {
      main: teal[700],
    },
    secondary: {
      main: yellow[700],
    },
    error: {
      main: red[600],
    },
    background: {
      default: '#fafafa',
    },
  },
});

export function getDefaultDarkMode(): boolean {
  if (window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  return false;
}

export function getNextDarkMode(darkMode: boolean | null) {
  if (darkMode === null) {
    return true;
  } else if (darkMode === false) {
    return null;
  }
  return false;
}

const getTheme = (darkMode?: boolean | null) => {
  const calculatedDarkMode = darkMode === null ? getDefaultDarkMode() : darkMode;
  return calculatedDarkMode ? dark : light;
};

export default getTheme;
