import { ChangeEvent, useCallback, useMemo, useState } from 'react'
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
} from '@mui/material'
import {
  CRITERIA_DISPLAY,
  CRITERIA_DISPLAY_MAP,
  CriterionName,
  SortCriterion,
} from '../../utils/customSort'
import { RemoveIcon } from '../Icons'
import { useSortCriteria } from '../../state/selectors'

export interface Props {
  onClose: () => void,
  open: boolean,
}


function SortCriterionField({
  chosenCriteria,
  criterion,
  index,
  onChangeKey,
  onChangeReverse,
  onRemove,
}: {
  chosenCriteria: Set<CriterionName>,
  criterion: SortCriterion,
  index: number,
  onChangeKey: (index: number, key: CriterionName) => void,
  onChangeReverse: (index: number, reverse: boolean) => void,
  onRemove: (index: number) => void,
}) {
  const handleChangeKey = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => (
      onChangeKey(index, event.target.value as CriterionName)
    ),
    [index, onChangeKey],
  )
  const handleChangeReverse = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => (
      onChangeReverse(index, !!parseInt(event.target.value))
    ),
    [index, onChangeReverse],
  )
  const handleRemove = useCallback(
    () => onRemove(index),
    [index, onRemove],
  )

  return (
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
        onChange={handleChangeKey}
        value={criterion.type}
        label="Field"
        select
        variant="standard"
      >
        {CRITERIA_DISPLAY.filter(
          cd => criterion.type === cd[0] || !chosenCriteria.has(cd[0]),
        ).map(([key, display]) => (
          <MenuItem key={key} value={key}>
            {display.name}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        data-cy="sort-criterion-order"
        fullWidth
        onChange={handleChangeReverse}
        value={+criterion.reverse}
        label="Order"
        select
        variant="standard"
      >
        <MenuItem value={0}>
          {CRITERIA_DISPLAY_MAP[criterion.type].normal}
        </MenuItem>
        <MenuItem value={1}>
          {CRITERIA_DISPLAY_MAP[criterion.type].reverse}
        </MenuItem>
      </TextField>

      <IconButton onClick={handleRemove}>
        <RemoveIcon />
      </IconButton>
    </Stack>
  )
}


function SortDialog({
  onClose,
  open,
}: Props) {
  const [sortCriteria, setSortCriteria] = useSortCriteria()

  const [localCriteria, setLocalCriteria] = useState<SortCriterion[]>([])

  const [prevSortCriteria, setPrevSortCriteria] = useState(sortCriteria)
  if (sortCriteria !== prevSortCriteria) {
    setPrevSortCriteria(sortCriteria)
    setLocalCriteria(sortCriteria)
  }

  const chosenCriteria = useMemo(
    () => new Set(localCriteria.map(lc => lc.type)),
    [localCriteria],
  )

  const handleAdd = useCallback(
    () => setLocalCriteria(lc => {
      const notChosen = CRITERIA_DISPLAY.filter(
        cd => !chosenCriteria.has(cd[0]),
      )
      return [
        ...lc,
        { type: notChosen[0][0], reverse: false },
      ]
    }),
    [chosenCriteria],
  )
  const handleChangeKey = useCallback(
    (index: number, key: CriterionName) => setLocalCriteria(lc => [
      ...lc.slice(0, index),
      { ...lc[index], type: key },
      ...lc.slice(index + 1),
    ]),
    [],
  )
  const handleChangeReverse = useCallback(
    (index: number, reverse: boolean) => setLocalCriteria(lc => [
      ...lc.slice(0, index),
      { ...lc[index], reverse },
      ...lc.slice(index + 1),
    ]),
    [],
  )
  const handleRemove = useCallback(
    (index: number) => setLocalCriteria(
      lc => [...lc.slice(0, index), ...lc.slice(index + 1)],
    ),
    [],
  )
  const handleDone = useCallback(
    () => {
      setSortCriteria(localCriteria)
      onClose()
    },
    [localCriteria, onClose, setSortCriteria],
  )

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

            <SortCriterionField
              chosenCriteria={chosenCriteria}
              criterion={lc}
              index={index}
              onChangeKey={handleChangeKey}
              onChangeReverse={handleChangeReverse}
              onRemove={handleRemove}
            />

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
          fullWidth
          onClick={handleDone}
          variant="contained"
        >
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default SortDialog
