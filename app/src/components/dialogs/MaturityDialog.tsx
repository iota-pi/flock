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
  TextField,
} from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import FlipMove from 'react-flip-move';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useItems, useMaturity, useVault } from '../../state/selectors';
import { getItemId } from '../../utils';
import { RemoveIcon } from '../Icons';
import { PersonItem } from '../../state/items';
import Vault from '../../api/Vault';

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

export function updateMaturityForPeople(
  vault: Vault,
  people: PersonItem[],
  original: MaturityControl[],
  updated: MaturityControl[],
) {
  const map = new Map<string, PersonItem[]>();
  people.forEach(person => {
    if (person.maturity) {
      const existing = map.get(person.maturity) || [];
      map.set(person.maturity, [...existing, person]);
    }
  });
  const updatedPeople: PersonItem[] = [];
  for (const stage of updated) {
    const originalStage = original.find(({ id }) => id === stage.id);
    if (originalStage && stage.name !== originalStage.name) {
      const peopleWithMaturity = map.get(originalStage.name) || [];
      updatedPeople.push(
        ...peopleWithMaturity.map(p => ({ ...p, maturity: stage.name.trim() })),
      );
    }
  }
  vault.store(updatedPeople);
}

function MaturitySingleStage({
  autoFocus,
  index,
  lastIndex,
  onChange,
  onMoveDown,
  onMoveUp,
  onRemove,
  stage,
}: {
  autoFocus: boolean,
  index: number,
  lastIndex: number,
  onChange: (id: string, name: string) => void,
  onMoveDown: (id: string) => void,
  onMoveUp: (id: string) => void,
  onRemove: (id: string) => void,
  stage: MaturityControl,
}) {
  const classes = useStyles();

  const handleRemove = useCallback(() => onRemove(stage.id), [onRemove, stage.id]);
  const handleMoveDown = useCallback(() => onMoveDown(stage.id), [onMoveDown, stage.id]);
  const handleMoveUp = useCallback(() => onMoveUp(stage.id), [onMoveUp, stage.id]);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(stage.id, event.target.value),
    [onChange, stage.id],
  );

  return (
    <div
      className={classes.maturityItem}
      data-cy="maturity-stage"
    >
      <div className={classes.orderControls}>
        <IconButton
          data-cy="maturity-move-up"
          disabled={index === 0}
          onClick={handleMoveUp}
          size="small"
        >
          <ExpandLessIcon />
        </IconButton>

        <IconButton
          data-cy="maturity-move-down"
          disabled={index === lastIndex}
          onClick={handleMoveDown}
          size="small"
        >
          <ExpandMoreIcon />
        </IconButton>
      </div>

      <span className={classes.indexNumber}>
        {index + 1}.
      </span>

      <TextField
        autoFocus={autoFocus}
        data-cy="maturity-stage-name"
        fullWidth
        onChange={handleChange}
        value={stage.name}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                data-cy="maturity-remove-stage"
                onClick={handleRemove}
                size="small"
              >
                <RemoveIcon />
              </IconButton>
            </InputAdornment>
          ),
        }}
        variant="standard"
      />
    </div>
  );
}

function MaturityDialog({
  onClose,
  open,
}: Props) {
  const classes = useStyles();
  const people = useItems<PersonItem>('person');
  const vault = useVault();

  const [maturity, setMaturity] = useMaturity();
  const [localMaturity, setLocalMaturity] = useState<MaturityControl[]>([]);
  const [original, setOriginal] = useState<MaturityControl[]>([]);
  const [disableAnimation, setDisableAnimation] = useState(false);
  const [autoFocusId, setAutoFocusId] = useState<string>();

  useEffect(
    () => {
      const withIds = maturity.map(m => ({ id: getItemId(), name: m }));
      setLocalMaturity(withIds);
      setOriginal(withIds);
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
    (id: string, name: string) => setLocalMaturity(lm => {
      const index = lm.findIndex(m => m.id === id);
      return [
        ...lm.slice(0, index),
        { ...lm[index], name },
        ...lm.slice(index + 1),
      ];
    }),
    [],
  );
  const handleMoveDown = useCallback(
    (id: string) => setLocalMaturity(lm => {
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
  const handleMoveUp = useCallback(
    (id: string) => setLocalMaturity(lm => {
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
  const handleRemove = useCallback(
    (id: string) => {
      setDisableAnimation(true);
      setLocalMaturity(lm => lm.filter(m => m.id !== id));
    },
    [],
  );
  const handleDone = useCallback(
    () => {
      updateMaturityForPeople(vault!, people, original, localMaturity);
      setMaturity(localMaturity.map(m => m.name.trim()).filter(m => m));
      onClose();
    },
    [
      localMaturity,
      onClose,
      original,
      people,
      setMaturity,
      vault,
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

              <MaturitySingleStage
                autoFocus={lm.id === autoFocusId}
                index={index}
                lastIndex={localMaturity.length - 1}
                onChange={handleChange}
                onMoveDown={handleMoveDown}
                onMoveUp={handleMoveUp}
                onRemove={handleRemove}
                stage={lm}
              />

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
          fullWidth
          onClick={handleDone}
          variant="contained"
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default MaturityDialog;
