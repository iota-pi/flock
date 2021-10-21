import {
  ChangeEvent,
  ReactNode,
  useCallback,
  useMemo,
} from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  MenuItem,
  TextField,
} from '@material-ui/core';
import { useMaturity } from '../state/selectors';

const useStyles = makeStyles(() => ({
  faded: {
    opacity: 0.8,
  },
}));

export interface Props {
  className?: string,
  fullWidth?: boolean,
  icon?: ReactNode,
  id?: string,
  label?: string,
  maturity: string | null,
  onChange: (maturity: string | null) => void,
}


function MaturityPicker({
  className,
  fullWidth,
  id,
  label,
  maturity,
  onChange,
}: Props) {
  const classes = useStyles();

  const [maturityStages] = useMaturity();
  const maturityOptions = useMemo<{ value: string, label: string, default?: boolean }[]>(
    () => [
      { value: '', label: 'Not Specified', default: true },
      ...maturityStages.map(m => ({ value: m, label: m })),
    ],
    [maturityStages],
  );
  const maturityWithFallback = maturity && maturityStages.includes(maturity) ? maturity : '';

  const handleChange = useCallback(
    (event: ChangeEvent<{ value: unknown }>) => {
      onChange(event.target.value as string || null);
    },
    [onChange],
  );

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
      variant="standard"
    >
      {maturityOptions.map(option => (
        <MenuItem
          className={option.default ? classes.faded : undefined}
          key={option.value}
          value={option.value || ''}
        >
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

export default MaturityPicker;
