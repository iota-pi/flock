import {
  useCallback,
  useState,
} from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  Button,
  Container,
  Divider,
  Grid,
  Typography,
} from '@material-ui/core';
import ConfirmationDialog from '../../dialogs/ConfirmationDialog';
import { DeleteIcon, NextIcon, ReportIcon, SaveIcon } from '../../Icons';


const useStyles = makeStyles(theme => ({
  emphasis: {
    fontWeight: 500,
  },
  filler: {
    flexGrow: 1,
  },
  container: {
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
  },
}));

export interface BaseProps {
  itemIsNew?: boolean,
  itemIsNote?: boolean,
  itemName?: string,
  permanentDrawer?: boolean,
  promptSave?: boolean,
}

export interface PropsWithSave extends BaseProps {
  canSave: boolean,
  onCancel: () => void,
  onDelete: () => void,
  onSkip?: undefined,
  onDone?: undefined,
  onNext?: undefined,
  onReport?: () => void,
  onSave: () => void,
}

export interface PropsWithDone extends BaseProps {
  canSave?: undefined,
  onCancel?: undefined,
  onDelete?: undefined,
  onDone: () => void,
  onNext?: undefined,
  onReport?: undefined,
  onSave?: undefined,
  onSkip?: () => void,
}

export interface PropsWithNext extends BaseProps {
  canSave?: undefined,
  onCancel?: undefined,
  onDelete?: undefined,
  onDone?: undefined,
  onNext: () => void,
  onReport?: undefined,
  onSave?: undefined,
  onSkip: () => void,
}

export type Props = PropsWithSave | PropsWithDone | PropsWithNext;


function DrawerActions({
  canSave,
  itemIsNew,
  itemIsNote,
  itemName,
  onCancel,
  onDelete,
  onDone,
  onNext,
  onReport,
  onSave,
  onSkip,
  permanentDrawer,
  promptSave,
}: Props) {
  const classes = useStyles();

  const [showConfirm, setShowConfirm] = useState(false);

  const handleClickDelete = useCallback(
    () => {
      if (!itemIsNew) {
        setShowConfirm(true);
      } else if (onCancel) {
        onCancel();
      }
    },
    [itemIsNew, onCancel],
  );
  const handleClickConfirmCancel = useCallback(() => setShowConfirm(false), []);

  return (
    <>
      <Divider />

      <Container className={classes.container}>
        <Grid container spacing={2}>
          {onReport && (
            <Grid item xs={12}>
              <Button
                data-cy="drawer-report"
                disabled={itemIsNew}
                fullWidth
                onClick={onReport}
                startIcon={itemIsNew ? undefined : <ReportIcon />}
                variant="outlined"
              >
                Group Report
              </Button>
            </Grid>
          )}

          {onSkip && (
            <Grid item xs={12}>
              <Button
                data-cy="drawer-skip"
                fullWidth
                onClick={onSkip}
                variant="outlined"
              >
                Skip
              </Button>
            </Grid>
          )}

          {onCancel && onDelete && (
            <Grid item xs={12} sm={6}>
              <Button
                color={itemIsNew ? undefined : 'error'}
                data-cy="drawer-cancel"
                fullWidth
                onClick={handleClickDelete}
                startIcon={itemIsNew ? undefined : <DeleteIcon />}
                variant="outlined"
              >
                {itemIsNew ? 'Cancel' : 'Delete'}
              </Button>
            </Grid>
          )}

          {onSave && (
            <Grid item xs={12} sm={6}>
              <Button
                color="primary"
                data-cy="drawer-done"
                disabled={!canSave}
                fullWidth
                onClick={onSave}
                startIcon={<SaveIcon />}
                variant={promptSave ? 'contained' : 'outlined'}
              >
                {permanentDrawer ? 'Save' : 'Done'}
              </Button>
            </Grid>
          )}

          {onDone && (
            <Grid item xs={12}>
              <Button
                color="primary"
                data-cy="drawer-done"
                fullWidth
                onClick={onDone}
                variant="contained"
              >
                Done
              </Button>
            </Grid>
          )}

          {onNext && (
            <Grid item xs={12}>
              <Button
                color="primary"
                data-cy="drawer-next"
                endIcon={<NextIcon />}
                fullWidth
                onClick={onNext}
                variant="contained"
              >
                Next
              </Button>
            </Grid>
          )}
        </Grid>
      </Container>

      {onDelete && (
        <ConfirmationDialog
          open={showConfirm}
          onConfirm={onDelete}
          onCancel={handleClickConfirmCancel}
        >
          <Typography paragraph>
            Are you sure you want to delete
            {' '}
            {itemIsNote ? (
              ` this ${itemName}?`
            ) : (
              <>
                <span className={classes.emphasis}>
                  {itemName}
                </span>
                , and all associated notes?
              </>
            )}
          </Typography>

          <Typography paragraph>
            This action cannot be undone.
          </Typography>
        </ConfirmationDialog>
      )}
    </>
  );
}

export default DrawerActions;
