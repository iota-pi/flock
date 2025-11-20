import { ChangeEvent, useCallback, useMemo } from 'react'
import {
  IconButton,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material'
import { DatePicker } from '@mui/x-date-pickers'
import '@mui/lab'
import {
  FILTER_CRITERIA_DISPLAY_MAP,
  FilterCriterionType,
  FilterCriterion,
  getBaseValue,
  FILTER_OPERATORS_MAP,
  FilterOperatorName,
} from '../../../utils/customFilter'
import { RemoveIcon } from '../../Icons'
import FrequencyPicker from '../../FrequencyPicker'
import { Frequency } from '../../../utils/frequencies'

export function FilterCriterionDisplay({
  chosenCriteria,
  criterion,
  onChange,
  onRemove,
  index,
}: {
  chosenCriteria: Set<FilterCriterionType>,
  criterion: FilterCriterion,
  onChange: (index: number, criterion: FilterCriterion) => void,
  onRemove: (index: number) => void,
  index: number,
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
      onChange(index, {
        ...criterion,
        type: newCriterionType,
        operator,
        baseOperator,
        value,
      })
    },
    [criterion, onChange, index],
  )
  const handleChangeOperation = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const operatorName = event.target.value as FilterOperatorName
      const operatorDetails = FILTER_OPERATORS_MAP[operatorName]
      onChange(index, {
        ...criterion,
        baseOperator: operatorDetails.baseOperator,
        operator: operatorName,
        inverse: operatorDetails.inverse,
      })
    },
    [criterion, onChange, index],
  )
  const handleChangeValue = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value as FilterCriterion['value']
      onChange(index, { ...criterion, value })
    },
    [criterion, onChange, index],
  )
  const handleChangeDateValue = useCallback(
    (date: Date | null) => {
      onChange(index, {
        ...criterion,
        value: date?.getTime() || new Date().getTime(),
      })
    },
    [criterion, onChange, index],
  )
  const handleChangeFrequencyValue = useCallback(
    (frequency: Frequency) => {
      onChange(index, {
        ...criterion,
        value: frequency,
      })
    },
    [criterion, onChange, index],
  )
  const handleRemove = useCallback(
    () => onRemove(index),
    [onRemove, index],
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
        {Object.keys(FILTER_CRITERIA_DISPLAY_MAP).filter(
          (cd) => criterion.type === (cd as FilterCriterionType) || !chosenCriteria.has(cd as FilterCriterionType),
        ).map(key => (
          <MenuItem key={key} value={key}>
            {FILTER_CRITERIA_DISPLAY_MAP[key as FilterCriterionType].name}
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
