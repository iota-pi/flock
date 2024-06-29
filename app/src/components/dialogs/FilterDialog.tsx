import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
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
import { DatePicker } from '@mui/x-date-pickers'
import '@mui/lab'
import {
  FILTER_CRITERIA_DISPLAY,
  FILTER_CRITERIA_DISPLAY_MAP,
  FilterCriterionType,
  FilterCriterion,
  getBaseValue,
  FILTER_OPERATORS_MAP,
  FilterOperatorName,
  FilterBaseOperatorName,
} from '../../utils/customFilter'
import { FilterIcon, RemoveIcon } from '../Icons'
import { useAppDispatch, useAppSelector } from '../../store'
import { setUi } from '../../state/ui'
import FrequencyPicker from '../FrequencyPicker'
import { Frequency } from '../../utils/frequencies'

export interface Props {
  onClose: () => void,
  open: boolean,
}

export function FilterCriterionDisplay({
  chosenCriteria,
  criterion,
  onChange,
  onRemove,
}: {
  chosenCriteria: Set<FilterCriterionType>,
  criterion: FilterCriterion,
  onChange: (prevCriterionName: FilterCriterionType, criterion: FilterCriterion) => void,
  onRemove: (criterion: FilterCriterionType) => void,
}) {
  const criterionDetails = FILTER_CRITERIA_DISPLAY_MAP[criterion.type]

  const handleChangeKey = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const newCriterionType = event.target.value as FilterCriterionType
      const value = (
        typeof getBaseValue(newCriterionType) === typeof criterion.value
          ? criterion.value
          : getBaseValue(newCriterionType)
      )
      const operator = FILTER_CRITERIA_DISPLAY_MAP[newCriterionType].operators[0]
      const baseOperator = FILTER_OPERATORS_MAP[operator].baseOperator
      onChange(criterion.type, {
        ...criterion,
        type: newCriterionType,
        operator,
        baseOperator,
        value,
      })
    },
    [criterion, onChange],
  )
  const handleChangeOperation = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const operatorName = event.target.value as FilterOperatorName
      const operatorDetails = FILTER_OPERATORS_MAP[operatorName]
      onChange(criterion.type, {
        ...criterion,
        baseOperator: operatorDetails.baseOperator,
        operator: operatorName,
        inverse: operatorDetails.inverse,
      })
    },
    [criterion, onChange],
  )
  const handleChangeValue = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value as FilterCriterion['value']
      onChange(criterion.type, { ...criterion, value })
    },
    [criterion, onChange],
  )
  const handleChangeDateValue = useCallback(
    (date: Date | null) => {
      onChange(
        criterion.type,
        {
          ...criterion,
          value: date?.getTime() || new Date().getTime(),
        },
      )
    },
    [criterion, onChange],
  )
  const handleChangeFrequencyValue = useCallback(
    (frequency: Frequency) => {
      onChange(
        criterion.type,
        {
          ...criterion,
          value: frequency,
        },
      )
    },
    [criterion, onChange],
  )
  const handleRemove = useCallback(
    () => onRemove(criterion.type),
    [criterion.type, onRemove],
  )

  const currentDate = useMemo(
    () => (criterionDetails.dataType === 'date' ? new Date(criterion.value as number) : null),
    [criterion, criterionDetails],
  )

  return (
    <Stack
      data-cy="filter-criterion"
      direction="row"
      alignItems="center"
      spacing={2}
      py={2}
    >
      <TextField
        data-cy="filter-criterion-name"
        fullWidth
        onChange={handleChangeKey}
        value={criterion.type}
        label="Field"
        select
        variant="standard"
      >
        {FILTER_CRITERIA_DISPLAY.filter(
          cd => criterion.type === cd[0] || !chosenCriteria.has(cd[0]),
        ).map(([key, display]) => (
          <MenuItem key={key} value={key}>
            {display.name}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        data-cy="filter-criterion-operation"
        fullWidth
        onChange={handleChangeOperation}
        value={criterion.operator}
        label="Comparison"
        select
        variant="standard"
      >
        {criterionDetails.operators.map(operator => (
          <MenuItem key={operator} value={operator}>
            {FILTER_OPERATORS_MAP[operator].name}
          </MenuItem>
        ))}
      </TextField>

      {criterionDetails.dataType === 'string' && (
        <TextField
          data-cy="filter-criterion-value"
          fullWidth
          label="Value"
          onChange={handleChangeValue}
          value={criterion.value}
          variant="standard"
        />
      )}
      {criterionDetails.dataType === 'number' && (
        <TextField
          data-cy="filter-criterion-value"
          fullWidth
          label="Value"
          onChange={handleChangeValue}
          type="number"
          value={+criterion.value}
          variant="standard"
        />
      )}
      {criterionDetails.dataType === 'boolean' && (
        <TextField
          data-cy="filter-criterion-value"
          fullWidth
          onChange={handleChangeValue}
          label="Value"
          select
          value={criterion.value as boolean}
          variant="standard"
        >
          <MenuItem value={true as unknown as number}>
            True
          </MenuItem>
          <MenuItem value={false as unknown as number}>
            False
          </MenuItem>
        </TextField>
      )}
      {criterionDetails.dataType === 'date' && (
        <DatePicker<Date | null>
          data-cy="filter-criterion-value"
          format="dd/MM/yyyy"
          label="Value"
          onChange={handleChangeDateValue}
          slotProps={{ textField: { fullWidth: true, variant: 'standard' } }}
          value={currentDate}
        />
      )}
      {criterionDetails.dataType === 'frequency' && (
        <FrequencyPicker
          fullWidth
          id="prayer"
          onChange={handleChangeFrequencyValue}
          label="Value"
          frequency={criterion.value as Frequency}
        />
      )}

      <IconButton onClick={handleRemove}>
        <RemoveIcon />
      </IconButton>
    </Stack>
  )
}


function FilterDialog({
  onClose,
  open,
}: Props) {
  const dispatch = useAppDispatch()
  const filterCriteria = useAppSelector(state => state.ui.filters)
  const [localCriteria, setLocalCriteria] = useState<FilterCriterion[]>([])

  useEffect(
    () => {
      if (open) {
        setLocalCriteria(
          filterCriteria.filter(fc => !!FILTER_CRITERIA_DISPLAY_MAP[fc.type]),
        )
      }
    },
    [filterCriteria, open],
  )

  const chosenCriteria = useMemo(
    () => new Set(localCriteria.map(lc => lc.type)),
    [localCriteria],
  )

  const handleAdd = useCallback(
    () => setLocalCriteria(lc => {
      const notChosen = FILTER_CRITERIA_DISPLAY.filter(
        cd => !chosenCriteria.has(cd[0]),
      )
      const newCriterionType = notChosen[0][0]
      const newCriterionDetails = notChosen[0][1]
      return [
        ...lc,
        {
          baseOperator: newCriterionDetails.operators[0] as FilterBaseOperatorName,
          inverse: false,
          operator: newCriterionDetails.operators[0],
          type: newCriterionType,
          value: getBaseValue(newCriterionType),
        },
      ]
    }),
    [chosenCriteria],
  )
  const handleChange = useCallback(
    (prevType: FilterCriterionType, criterion: FilterCriterion) => (
      setLocalCriteria(prevCriteria => {
        const index = prevCriteria.findIndex(c => c.type === prevType)
        if (index > -1) {
          return [
            ...prevCriteria.slice(0, index),
            criterion,
            ...prevCriteria.slice(index + 1),
          ]
        }
        return [...prevCriteria, criterion]
      })
    ),
    [],
  )
  const handleRemove = useCallback(
    (type: FilterCriterionType) => setLocalCriteria(
      prevCriteria => prevCriteria.filter(x => x.type !== type),
    ),
    [],
  )
  const handleClear = useCallback(
    () => {
      setLocalCriteria([])
      dispatch(setUi({ filters: [] }))
    },
    [dispatch],
  )
  const handleDone = useCallback(
    () => {
      dispatch(setUi({ filters: localCriteria }))
      onClose()
    },
    [dispatch, localCriteria, onClose],
  )

  return (
    <Dialog
      onClose={onClose}
      open={open}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        Filter Conditions
      </DialogTitle>

      <DialogContent>
        {localCriteria.map((lc: FilterCriterion, index) => (
          <div key={lc.type}>
            {index === 0 && <Divider />}

            <FilterCriterionDisplay
              criterion={lc}
              chosenCriteria={chosenCriteria}
              onChange={handleChange}
              onRemove={handleRemove}
            />

            <Divider />
          </div>
        ))}

        <Button
          data-cy="add-filter-criterion"
          disabled={localCriteria.length >= FILTER_CRITERIA_DISPLAY.length}
          fullWidth
          onClick={handleAdd}
          variant="outlined"
        >
          Add filter condition
        </Button>
      </DialogContent>

      <DialogActions>
        <Button
          data-cy="filter-cancel"
          disabled={localCriteria.length === 0}
          fullWidth
          onClick={handleClear}
          startIcon={<RemoveIcon />}
          variant="outlined"
        >
          Clear
        </Button>

        <Button
          color="primary"
          data-cy="filter-done"
          fullWidth
          onClick={handleDone}
          startIcon={undefined && <FilterIcon />}
          variant="contained"
        >
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default FilterDialog
