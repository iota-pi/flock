import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  makeStyles,
  TextField,
} from '@material-ui/core';
import FlipMove from 'react-flip-move';
import ExpandLessIcon from '@material-ui/icons/ExpandLess';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import { useMetadata } from '../../state/selectors';
import { getItemId } from '../../utils';
import { DEFAULT_MATURITY } from '../../state/account';
import { RemoveIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  root: {},
  listItemContainer: {
    position: 'relative',
  },
  maturityItem: {
    display: 'flex',
    alignItems: 'center',
    flexGrow: 1,
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(1),
  },
  indexNumber: {
    fontWeight: 500,
    marginRight: theme.spacing(2),
  },
  orderControls: {
    display: 'flex',
    flexDirection: 'column',
    marginRight: theme.spacing(2),
  },
  addButton: {
    marginTop: theme.spacing(2),
  },
}));

export interface Props {
  onClose: () => void,
  open: boolean,
}

export interface MaturityControl {
  id: string,
  name: string,
}


function MaturityDialog({
  onClose,
  open,
}: Props) {
  const classes = useStyles();

  const [maturity, setMaturity] = useMetadata<string[]>('maturity', DEFAULT_MATURITY);
  const [localMaturity, setLocalMaturity] = useState<MaturityControl[]>([]);
  const [disableAnimation, setDisableAnimation] = useState(false);

  useEffect(
    () => {
      setLocalMaturity(maturity.map(m => ({ id: getItemId(), name: m })));
    },
    [maturity],
  );
  useEffect(
    () => {
      if (disableAnimation) {
        setDisableAnimation(false);
      }
    },
    [disableAnimation],
  );

  const handleAdd = useCallback(
    () => {
      setDisableAnimation(true);
      setLocalMaturity(lm => [...lm, { id: getItemId(), name: '' }]);
    },
    [],
  );
  const handleChange = useCallback(
    (id: string) => (event: ChangeEvent<HTMLInputElement>) => setLocalMaturity(lm => {
      const index = lm.findIndex(m => m.id === id);
      return [
        ...lm.slice(0, index),
        { ...lm[index], name: event.target.value },
        ...lm.slice(index + 1),
      ];
    }),
    [],
  );
  const handleRemove = useCallback(
    (id: string) => () => {
      setDisableAnimation(true);
      setLocalMaturity(lm => lm.filter(m => m.id !== id));
    },
    [],
  );
  const handleMoveUp = useCallback(
    (id: string) => () => setLocalMaturity(lm => {
      const index = lm.findIndex(m => m.id === id);
      return [
        ...lm.slice(0, index - 1),
        lm[index],
        lm[index - 1],
        ...lm.slice(index + 1),
      ];
    }),
    [],
  );
  const handleMoveDown = useCallback(
    (id: string) => () => setLocalMaturity(lm => {
      const index = lm.findIndex(m => m.id === id);
      return [
        ...lm.slice(0, index),
        lm[index + 1],
        lm[index],
        ...lm.slice(index + 2),
      ];
    }),
    [],
  );
  const handleDone = useCallback(
    () => {
      setMaturity(localMaturity.map(m => m.name.trim()).filter(m => m));
      onClose();
    },
    [localMaturity, onClose, setMaturity],
  );

  return (
    <Dialog
      className={classes.root}
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Edit Maturity Stages
      </DialogTitle>

      <DialogContent>
        <FlipMove
          enterAnimation="none"
          leaveAnimation="none"
          disableAllAnimations={disableAnimation}
        >
          {localMaturity.map((lm, index) => (
            <div key={lm.id}>
              {index === 0 && <Divider />}

              <div className={classes.maturityItem}>
                <div className={classes.orderControls}>
                  <IconButton
                    disabled={index === 0}
                    onClick={handleMoveUp(lm.id)}
                    size="small"
                  >
                    <ExpandLessIcon />
                  </IconButton>

                  <IconButton
                    disabled={index === localMaturity.length - 1}
                    onClick={handleMoveDown(lm.id)}
                    size="small"
                  >
                    <ExpandMoreIcon />
                  </IconButton>
                </div>

                <span className={classes.indexNumber}>
                  {index + 1}.
                </span>

                <TextField
                  fullWidth
                  onChange={handleChange(lm.id)}
                  value={lm.name}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={handleRemove(lm.id)}
                          size="small"
                        >
                          <RemoveIcon />
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />
              </div>

              <Divider />
            </div>
          ))}
        </FlipMove>

        <Button
          className={classes.addButton}
          fullWidth
          onClick={handleAdd}
          variant="outlined"
        >
          Add maturity stage
        </Button>
      </DialogContent>

      <DialogActions>
        <Button
          onClick={onClose}
          variant="outlined"
          fullWidth
        >
          Cancel
        </Button>

        <Button
          color="primary"
          disabled={localMaturity.length === 0}
          onClick={handleDone}
          variant="outlined"
          fullWidth
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default MaturityDialog;
