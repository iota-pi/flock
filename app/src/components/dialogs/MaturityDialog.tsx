import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
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
import { useItems, useMetadata } from '../../state/selectors';
import { getItemId } from '../../utils';
import { DEFAULT_MATURITY } from '../../state/account';
import { RemoveIcon } from '../Icons';
import { PersonItem, updateItems } from '../../state/items';
import { useAppDispatch } from '../../store';

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
  const dispatch = useAppDispatch();
  const people = useItems<PersonItem>('person');
  const maturityToPeopleMap = useMemo(
    () => {
      const map = new Map<string, PersonItem[]>();
      people.forEach(person => {
        if (person.maturity) {
          const existing = map.get(person.maturity) || [];
          map.set(person.maturity, [...existing, person]);
        }
      });
      return map;
    },
    [people],
  );

  const [maturity, setMaturity] = useMetadata<string[]>('maturity', DEFAULT_MATURITY);
  const [localMaturity, setLocalMaturity] = useState<MaturityControl[]>([]);
  const [originalWithIds, setOriginalWithIds] = useState<MaturityControl[]>([]);
  const [disableAnimation, setDisableAnimation] = useState(false);
  const [autoFocusId, setAutoFocusId] = useState<string>();

  useEffect(
    () => {
      const withIds = maturity.map(m => ({ id: getItemId(), name: m }));
      setLocalMaturity(withIds);
      setOriginalWithIds(withIds);
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
      const id = getItemId();
      setLocalMaturity(lm => [...lm, { id, name: '' }]);
      setAutoFocusId(id);
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
      const updatedItems: PersonItem[] = [];
      for (const stage of localMaturity) {
        const original = originalWithIds.find(({ id }) => id === stage.id);
        if (original) {
          const peopleWithMaturity = maturityToPeopleMap.get(original.name) || [];
          updatedItems.push(
            ...peopleWithMaturity.map(p => ({ ...p, maturity: stage.name })),
          );
        }
      }
      dispatch(updateItems(updatedItems));
      setMaturity(localMaturity.map(m => m.name.trim()).filter(m => m));
      onClose();
    },
    [
      dispatch,
      localMaturity,
      onClose,
      originalWithIds,
      maturityToPeopleMap,
      setMaturity,
    ],
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

              <div
                className={classes.maturityItem}
                data-cy="maturity-stage"
              >
                <div className={classes.orderControls}>
                  <IconButton
                    data-cy="maturity-move-up"
                    disabled={index === 0}
                    onClick={handleMoveUp(lm.id)}
                    size="small"
                  >
                    <ExpandLessIcon />
                  </IconButton>

                  <IconButton
                    data-cy="maturity-move-down"
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
                  autoFocus={lm.id === autoFocusId}
                  data-cy="maturity-stage-name"
                  fullWidth
                  onChange={handleChange(lm.id)}
                  value={lm.name}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          data-cy="maturity-remove-stage"
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
          data-cy="maturity-add-stage"
          fullWidth
          onClick={handleAdd}
          variant="outlined"
        >
          Add maturity stage
        </Button>
      </DialogContent>

      <DialogActions>
        <Button
          data-cy="maturity-cancel"
          fullWidth
          onClick={onClose}
          variant="outlined"
        >
          Cancel
        </Button>

        <Button
          color="primary"
          data-cy="maturity-done"
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
