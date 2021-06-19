import React, {
  useCallback,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Divider,
  fade,
  Grid,
  Typography,
} from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import SaveIcon from '@material-ui/icons/Check';
import ReportIcon from '@material-ui/icons/Description';
import { getItemName, Item, ItemNote } from '../state/items';
import ConfirmationDialog from './ConfirmationDialog';


const useStyles = makeStyles(theme => ({
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  filler: {
    flexGrow: 1,
  },
  danger: {
    borderColor: theme.palette.error.light,
    color: theme.palette.error.light,

    '&:hover': {
      backgroundColor: fade(theme.palette.error.light, 0.08),
    },
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props {
  canSave: boolean,
  item: Item | ItemNote<'interaction'> | undefined,
  onCancel: () => void,
  onDelete: () => void,
  onReport?: () => void,
  onSave: () => void,
}


function DrawerActions({
  canSave,
  item,
  onCancel,
  onDelete,
  onReport,
  onSave,
}: Props) {
  const classes = useStyles();

  const [showConfirm, setShowConfirm] = useState(false);

  const handleClickDelete = useCallback(
    () => {
      if (item) {
        setShowConfirm(true);
      } else {
        onCancel();
      }
    },
    [item, onCancel],
  );
  const handleClickConfirmCancel = useCallback(() => setShowConfirm(false), []);

  return (
    <>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Divider />
        </Grid>

        {onReport && (
          <Grid item xs={12}>
            <Button
              onClick={onReport}
              variant="outlined"
              fullWidth
              startIcon={item ? <ReportIcon /> : undefined}
            >
              Group Report
            </Button>
          </Grid>
        )}

        <Grid item xs={12} sm={6}>
          <Button
            onClick={handleClickDelete}
            variant="outlined"
            fullWidth
            className={item ? classes.danger : undefined}
            startIcon={item ? <DeleteIcon /> : undefined}
          >
            {item ? 'Delete' : 'Cancel'}
          </Button>
        </Grid>

        <Grid item xs={12} sm={6}>
          <Button
            color="primary"
            onClick={onSave}
            variant="contained"
            fullWidth
            disabled={!canSave}
            startIcon={<SaveIcon />}
          >
            Done
          </Button>
        </Grid>
      </Grid>

      <ConfirmationDialog
        open={showConfirm}
        onConfirm={onDelete}
        onCancel={handleClickConfirmCancel}
      >
        <Typography paragraph>
          Are you sure you want to delete
          {' '}
          {item?.type !== 'interaction' ? (
            <>
              <span className={classes.emphasis}>
                {getItemName(item)}
              </span>
              , and all associated notes?
            </>
          ) : (
            'this interaction?'
          )}
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  );
}

export default DrawerActions;
