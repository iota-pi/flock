import makeStyles from '@material-ui/core/styles/makeStyles';
import { MuiIconType } from './Icons';


const useStyles = makeStyles(theme => ({
  root: {
    width: theme.typography.h1.fontSize,
    height: theme.typography.h1.fontSize,
  },
}));

interface Props {
  icon: MuiIconType,
}

function LargeIcon({
  icon: Icon,
}: Props) {
  const classes = useStyles();

  return (
    <Icon className={classes.root} />
  );
}

export default LargeIcon;
