import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
} from '@material-ui/core';
import {
  CRITERIA_DISPLAY,
  CRITERIA_DISPLAY_MAP,
  CriterionName,
  DEFAULT_CRITERIA,
  SortCriterion,
} from '../../utils/customSort';
import { RemoveIcon } from '../Icons';
import { useMetadata } from '../../state/selectors';

export interface Props {
  onClose: () => void,
  open: boolean,
}


function SortDialog({
  onClose,
  open,
}: Props) {
  const [sortCriteria, setSortCriteria] = useMetadata('sortCriteria', DEFAULT_CRITERIA);

  const [localCriteria, setLocalCriteria] = useState<SortCriterion[]>([]);

  useEffect(
    () => setLocalCriteria(sortCriteria),
    [sortCriteria],
  );

  const chosenCriteria = useMemo(
    () => new Set(localCriteria.map(lc => lc.type)),
    [localCriteria],
  );

  const handleAdd = useCallback(
    () => setLocalCriteria(lc => {
      const notChosen = CRITERIA_DISPLAY.filter(
        cd => !chosenCriteria.has(cd[0]),
      );
      return [
        ...lc,
        { type: notChosen[0][0], reverse: false },
      ];
    }),
    [chosenCriteria],
  );
  const handleChangeKey = useCallback(
    (index: number) => (event: ChangeEvent<HTMLInputElement>) => setLocalCriteria(lc => [
      ...lc.slice(0, index),
      { ...lc[index], type: event.target.value as CriterionName },
      ...lc.slice(index + 1),
    ]),
    [],
  );
  const handleChangeReverse = useCallback(
    (index: number) => (event: ChangeEvent<HTMLInputElement>) => setLocalCriteria(lc => [
      ...lc.slice(0, index),
      { ...lc[index], reverse: !!parseInt(event.target.value) },
      ...lc.slice(index + 1),
    ]),
    [],
  );
  const handleRemove = useCallback(
    (index: number) => () => setLocalCriteria(
      lc => [...lc.slice(0, index), ...lc.slice(index + 1)],
    ),
    [],
  );
  const handleDone = useCallback(
    () => {
      setSortCriteria(localCriteria);
      onClose();
    },
    [localCriteria, onClose, setSortCriteria],
  );

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Customise Sorting
      </DialogTitle>

      <DialogContent>
        {localCriteria.map((lc, index) => (
          <div key={lc.type}>
            {index === 0 && <Divider />}

            <Stack
              data-cy="sort-criterion"
              direction="row"
              alignItems="center"
              spacing={2}
              py={2}
            >
              <TextField
                data-cy="sort-criterion-name"
                fullWidth
                onChange={handleChangeKey(index)}
                value={lc.type}
                label="Field"
                select
                variant="standard"
              >
                {CRITERIA_DISPLAY.filter(
                  cd => lc.type === cd[0] || !chosenCriteria.has(cd[0]),
                ).map(([key, display]) => (
                  <MenuItem key={key} value={key}>
                    {display.name}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                data-cy="sort-criterion-order"
                fullWidth
                onChange={handleChangeReverse(index)}
                value={+lc.reverse}
                label="Order"
                select
                variant="standard"
              >
                <MenuItem value={0}>
                  {CRITERIA_DISPLAY_MAP[lc.type].normal}
                </MenuItem>
                <MenuItem value={1}>
                  {CRITERIA_DISPLAY_MAP[lc.type].reverse}
                </MenuItem>
              </TextField>

              <IconButton onClick={handleRemove(index)}>
                <RemoveIcon />
              </IconButton>
            </Stack>

            <Divider />
          </div>
        ))}

        <Button
          data-cy="add-sort-criterion"
          disabled={localCriteria.length >= CRITERIA_DISPLAY.length}
          fullWidth
          onClick={handleAdd}
          variant="outlined"
        >
          Add sort field
        </Button>
      </DialogContent>

      <DialogActions>
        <Button
          data-cy="sort-cancel"
          fullWidth
          onClick={onClose}
          variant="outlined"
        >
          Cancel
        </Button>

        <Button
          color="primary"
          data-cy="sort-done"
          disabled={localCriteria.length === 0}
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

export default SortDialog;
