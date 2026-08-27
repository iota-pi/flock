import { ChangeEvent, useCallback, useMemo } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'

import {
  FILTER_CRITERIA_DISPLAY_MAP,
  FilterCriterionType,
  FilterCriterion,
  getBaseValue,
  FILTER_OPERATORS_MAP,
  FilterOperatorName,
} from 'src/utils/customFilter'
import { RemoveIcon } from '../../Icons'
import FrequencyPicker from '../../FrequencyPicker'
import { Frequency } from 'src/utils/frequencies'
import { useItemsOfType } from 'src/state/selectors'
import type { GroupItem } from 'src/shared/schemas/items'
import { getItemName } from 'src/state/items'


export function FilterCriterionDisplay({
  availableCriteria,
  chosenCriteria,
  criterion,
  groups,
  onChange,
  onRemove,
  index,
}: {
  availableCriteria?: FilterCriterionType[],
  chosenCriteria: Set<FilterCriterionType>,
  criterion: FilterCriterion,
  groups?: GroupItem[],
  onChange: (index: number, criterion: FilterCriterion) => void,
  onRemove: (index: number) => void,
  index: number,
}) {
  const criterionDetails = FILTER_CRITERIA_DISPLAY_MAP[criterion.type]
  const validCriteriaList = availableCriteria ?? (Object.keys(FILTER_CRITERIA_DISPLAY_MAP) as FilterCriterionType[])

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
  const storeGroups = useItemsOfType<GroupItem>('group')
  const availableGroups = groups ?? storeGroups

  const activeGroups = useMemo(
    () => availableGroups.filter(g => !g.archived),
    [availableGroups],
  )
  const sortedActiveGroups = useMemo(
    () => [...activeGroups].sort((a, b) => (
      (getItemName(a) || '').localeCompare(getItemName(b) || '', undefined, { sensitivity: 'base' })
    )),
    [activeGroups],
  )

  const selectedGroup = useMemo(() => {
    if (!criterion.value) return null
    return (
      activeGroups.find(
        g => g.id === criterion.value || g.name === criterion.value || getItemName(g) === criterion.value,
      ) ?? null
    )
  }, [activeGroups, criterion.value])

  const handleChangeGroupValue = useCallback(
    (_event: React.SyntheticEvent, newValue: GroupItem | string | null) => {
      const value = newValue ? (typeof newValue === 'string' ? newValue : getItemName(newValue)) : ''
      onChange(index, {
        ...criterion,
        value,
      })
    },
    [criterion, index, onChange],
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
      spacing={2}
      sx={{
        alignItems: "center",
        py: 2
      }}>
      <TextField
        data-cy="filter-criterion-name"
        fullWidth
        onChange={handleChangeKey}
        value={criterion.type}
        label="Field"
        select
        variant="standard"
      >
        {validCriteriaList.filter(
          crt => criterion.type === crt || !chosenCriteria.has(crt),
        ).map(key => (
          <MenuItem key={key} value={key}>
            {FILTER_CRITERIA_DISPLAY_MAP[key].name}
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
      {criterionDetails.dataType === 'group' && (
        <Autocomplete
          data-cy="filter-criterion-value"
          fullWidth
          getOptionLabel={option => (typeof option === 'string' ? option : getItemName(option))}
          isOptionEqualToValue={(option, val) => (
            typeof val === 'string'
              ? option.name === val || option.id === val || getItemName(option) === val
              : option.id === val.id
          )}
          noOptionsText="No groups found"
          onChange={handleChangeGroupValue}
          options={sortedActiveGroups}
          renderInput={params => (
            <TextField
              {...params}
              label="Value"
              variant="standard"
            />
          )}
          value={selectedGroup}
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
        <DatePicker
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
      <IconButton aria-label="Remove filter criterion" onClick={handleRemove}>
        <RemoveIcon />
      </IconButton>
    </Stack>
  )
}
