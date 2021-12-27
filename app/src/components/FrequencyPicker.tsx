import {
  ReactNode,
  useCallback,
  useState,
} from 'react';
import makeStyles from '@mui/styles/makeStyles';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from '@mui/material';
import { FREQUENCIES, FREQUENCIES_TO_LABELS, Frequency } from '../utils/frequencies';

const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    alignItems: 'flex-end',

    '&$grow': {
      width: '100%',
    },
  },
  icon: {
    paddingRight: theme.spacing(1),
    transition: theme.transitions.create('color'),

    '&$highlighted': {
      color: theme.palette.primary.main,
    },
  },
  highlighted: {},
  grow: {
    flexGrow: 1,
  },
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
  const classes = useStyles();

  const [focused, setFocused] = useState(false);

  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const handleChangeNoteType = useCallback(
    (event: SelectChangeEvent<Frequency>) => {
      if (event.target.value) {
        onChange(event.target.value as Frequency);
      }
    },
    [onChange],
  );

  const rootClasses = [classes.root];
  if (fullWidth) {
    rootClasses.push(classes.grow);
  }

  return (
    <div className={rootClasses.join(' ')}>
      {icon && (
        <div
          className={`${classes.icon} ${focused ? classes.highlighted : ''}`}
        >
          {icon}
        </div>
      )}

      <div className={classes.grow}>
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
            onChange={handleChangeNoteType}
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
      </div>
    </div>
  );
}

export default FrequencyPicker;
