import { red, teal, yellow } from '@material-ui/core/colors';
import { createTheme } from '@material-ui/core/styles';

// A custom theme for this app
const theme = createTheme({
  palette: {
    primary: {
      main: teal[700],
    },
    secondary: {
      main: yellow[700],
    },
    error: {
      main: red.A400,
    },
    background: {
      default: '#202020',
      paper: '#202020',
    },
    mode: 'dark',
  },
});

export default theme;
