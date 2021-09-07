import { red, teal, yellow } from '@material-ui/core/colors';
import { createTheme } from '@material-ui/core/styles';

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
      // paper: '#202020',
    },
  },
});

const getTheme = (darkMode?: boolean) => (darkMode ? dark : light);

export default getTheme;
