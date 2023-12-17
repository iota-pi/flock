import {
  ChangeEvent,
  useCallback,
  useMemo,
} from 'react'
import {
  MenuItem,
  TextField,
  TextFieldProps,
} from '@mui/material'
import { useMaturity } from '../state/selectors'


export interface Props {
  className?: string,
  fullWidth?: boolean,
  id?: string,
  label?: string,
  maturity: string | null,
  onChange: (maturity: string | null) => void,
  variant?: TextFieldProps['variant'],
}


function MaturityPicker({
  className,
  fullWidth,
  id,
  label,
  maturity,
  onChange,
  variant = 'standard',
}: Props) {
  const [maturityStages] = useMaturity()
  const maturityOptions = useMemo<{ value: string, label: string, default?: boolean }[]>(
    () => [
      { value: '', label: 'Not Specified', default: true },
      ...maturityStages.map(m => ({ value: m, label: m })),
    ],
    [maturityStages],
  )
  const maturityWithFallback = maturity && maturityStages.includes(maturity) ? maturity : ''

  const handleChange = useCallback(
    (event: ChangeEvent<{ value: unknown }>) => {
      onChange(event.target.value as string || null)
    },
    [onChange],
  )

  return (
    <TextField
      className={className}
      data-cy="maturity-selection"
      fullWidth={fullWidth}
      id={id}
      label={label || 'Maturity'}
      onChange={handleChange}
      select
      value={maturityWithFallback}
      variant={variant}
    >
      {maturityOptions.map(option => (
        <MenuItem
          key={option.value}
          value={option.value || ''}
          sx={{ opacity: option.default ? 0.8 : undefined }}
        >
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  )
}

export default MaturityPicker
