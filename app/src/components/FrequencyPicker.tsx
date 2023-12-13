import {
  ReactNode,
  useCallback,
  useState,
} from 'react';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  styled,
} from '@mui/material';
import { FREQUENCIES, FREQUENCIES_TO_LABELS, Frequency } from '../utils/frequencies';


const IconHolder = styled('div')(({ theme }) => ({
  paddingRight: theme.spacing(1),
  transition: theme.transitions.create('color'),
}));

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
  const [focused, setFocused] = useState(false);

  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const handleChange = useCallback(
    (event: SelectChangeEvent<Frequency>) => {
      if (event.target.value) {
        onChange(event.target.value as Frequency);
      }
    },
    [onChange],
  );

  return (
    <Box
      display="flex"
      alignItems="flex-end"
      flexGrow={fullWidth ? 1 : undefined}
      width={fullWidth ? '100%' : undefined}
    >
      {icon && (
        <IconHolder color={focused ? 'primary' : undefined}>
          {icon}
        </IconHolder>
      )}

      <Box flexGrow={1}>
        <FormControl className={className} fullWidth={fullWidth} variant="standard">
          {label && (
            <InputLabel id={`frequency-selection-label-${id}`}>
              {label}
            </InputLabel>
          )}

          <Select
            id={`frequency-selection-${id}`}
            data-cy={`frequency-selection-${id}`}
            value={frequency}
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
          </Select>
        </FormControl>
      </Box>
    </Box>
  );
}

export default FrequencyPicker;
