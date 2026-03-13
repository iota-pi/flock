import {
  ReactNode,
  useCallback,
  useState,
  useMemo,
} from 'react'
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  TextField,
  Grid,
  styled,
} from '@mui/material'
import { FREQUENCIES, FREQUENCIES_TO_LABELS, Frequency } from '../utils/frequencies'

const IconHolder = styled('div')(({ theme }) => ({
  paddingTop: theme.spacing(2),
  paddingRight: theme.spacing(2),
  transition: theme.transitions.create('color'),
}))

export interface Props {
  className?: string,
  frequency: Frequency,
  fullWidth?: boolean,
  icon?: ReactNode,
  id?: string,
  label?: string,
  onChange: (frequency: Frequency) => void,
}

function FrequencyPicker({
  className,
  frequency,
  fullWidth,
  icon,
  id,
  label,
  onChange,
}: Props) {
  const [focused, setFocused] = useState(false)
  const [localAmount, setLocalAmount] = useState<string | null>(null)
  const [prevFrequency, setPrevFrequency] = useState(frequency)

  if (frequency !== prevFrequency) {
    setPrevFrequency(frequency)
    setLocalAmount(null)
  }

  const isCustom = typeof frequency === 'number' || (frequency as string) === 'custom'
  const selectValue = isCustom ? 'custom' : frequency

  // Compute default display unit and amount based on actual number value
  const { customAmountStr, customUnit } = useMemo(() => {
    if (typeof frequency !== 'number') return { customAmountStr: '1', customUnit: 'weeks' }

    // Default to weeks if it divides perfectly
    if (frequency % 7 === 0) return { customAmountStr: String(frequency / 7), customUnit: 'weeks' }
    // Default to months if it divides perfectly (approx 30.4 days)
    if (frequency % (365.25 / 12) === 0) return { customAmountStr: String(frequency / (365.25 / 12)), customUnit: 'months' }

    // Otherwise fallback to days
    return { customAmountStr: String(frequency), customUnit: 'days' }
  }, [frequency])

  const displayAmount = localAmount !== null ? localAmount : customAmountStr

  const handleFocus = useCallback(() => setFocused(true), [])
  const handleBlur = useCallback(() => setFocused(false), [])

  const handleChange = useCallback(
    (event: SelectChangeEvent<string>) => {
      const val = event.target.value
      if (val === 'custom') {
        onChange(7) // default to 1 week
      } else if (val) {
        onChange(val as Frequency)
      }
    },
    [onChange],
  )

  const handleCustomAmountChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const valStr = e.target.value
      setLocalAmount(valStr)
      const amount = parseInt(valStr, 10)
      if (!isNaN(amount) && amount > 0) {
        let days = amount
        if (customUnit === 'weeks') days = amount * 7
        if (customUnit === 'months') days = amount * (365.25 / 12)
        onChange(days)
      }
    },
    [onChange, customUnit],
  )

  const handleCustomUnitChange = useCallback(
    (e: SelectChangeEvent<string>) => {
      const amount = parseInt(customAmountStr, 10) || 1
      const newUnit = e.target.value
      let days = amount
      if (newUnit === 'weeks') days = amount * 7
      if (newUnit === 'months') days = amount * (365.25 / 12)
      onChange(days)
    },
    [onChange, customAmountStr],
  )

  return (
    <Box
      display="flex"
      alignItems="flex-start"
      flexGrow={fullWidth ? 1 : undefined}
      width={fullWidth ? '100%' : undefined}
    >
      {icon && (
        <IconHolder color={focused ? 'primary' : undefined}>
          {icon}
        </IconHolder>
      )}

      <Grid container spacing={2} columns={12} flexGrow={1} alignItems="flex-end">
        <Grid size={{ xs: 12, sm: isCustom ? 6 : 12 }}>
          <FormControl className={className} fullWidth={fullWidth} variant="standard">
            {label && (
              <InputLabel id={`frequency-selection-label-${id}`}>
                {label}
              </InputLabel>
            )}

            <Select
              id={`frequency-selection-${id}`}
              data-cy={id}
              value={selectValue}
              labelId={`frequency-selection-label-${id}`}
              onChange={handleChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              variant="standard"
            >
              {FREQUENCIES.map(value => (
                <MenuItem
                  data-cy={`frequency-${value}`}
                  key={FREQUENCIES_TO_LABELS[value]}
                  value={value}
                >
                  {FREQUENCIES_TO_LABELS[value]}
                </MenuItem>
              ))}
              <MenuItem value="custom" data-cy="frequency-custom">
                Custom...
              </MenuItem>
            </Select>
          </FormControl>
        </Grid>

        {isCustom && (
          <>
            <Grid size={{ xs: 6, sm: 3 }}>
              <TextField
                type="number"
                variant="standard"
                value={displayAmount}
                onChange={handleCustomAmountChange}
                slotProps={{ htmlInput: { min: 1, 'data-cy': 'custom-amount' } }}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 6, sm: 3 }}>
              <FormControl variant="standard" fullWidth>
                <Select
                  value={customUnit}
                  onChange={handleCustomUnitChange}
                  data-cy="custom-unit"
                >
                  <MenuItem value="days">Days</MenuItem>
                  <MenuItem value="weeks">Weeks</MenuItem>
                  <MenuItem value="months">Months</MenuItem>
                </Select>
              </FormControl>
            </Grid>
          </>
        )}
      </Grid>
    </Box>
  )
}

export default FrequencyPicker
