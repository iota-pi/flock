import { Grid } from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
import {
  Item, PersonItem,
} from '../state/items';
import FrequencyPicker from './FrequencyPicker';
import { Due, isDue } from '../utils/frequencies';
import { InteractionIcon, PrayerIcon } from './Icons';
import { formatDate } from '../utils';


const useStyles = makeStyles(theme => ({
  subscript: {
    paddingTop: theme.spacing(1),
    color: theme.palette.text.secondary,
  },
  baseDate: {
    transition: theme.transitions.create('color'),
  },
  dueDate: {
    color: theme.palette.secondary.main,
  },
  overdueDate: {
    color: theme.palette.error.main,
  },
}));

export interface Props {
  interactionFrequency: PersonItem['interactionFrequency'],
  lastInteraction: number,
  lastPrayer: number,
  noInteractions?: boolean,
  onChange: (data: Partial<Pick<Item, 'prayerFrequency' | 'interactionFrequency'>>) => void,
  prayerFrequency: PersonItem['prayerFrequency'],
}

function FrequencyControls({
  interactionFrequency,
  lastInteraction,
  lastPrayer,
  noInteractions = false,
  onChange,
  prayerFrequency,
}: Props) {
  const classes = useStyles();

  let lastPrayerText: string = 'never';
  let lastPrayerClass: string = '';
  if (lastPrayer) {
    lastPrayerText = formatDate(new Date(lastPrayer));
    const due = isDue(new Date(lastPrayer), prayerFrequency);
    if (due === Due.due) {
      lastPrayerClass = classes.dueDate;
    } else if (due === Due.overdue) {
      lastPrayerClass = classes.overdueDate;
    }
  }

  let lastInteractionText: string = 'never';
  let lastInteractionClass: string = '';
  if (lastInteraction) {
    lastInteractionText = formatDate(new Date(lastInteraction));
    const due = isDue(new Date(lastInteraction), interactionFrequency);
    if (due === Due.due) {
      lastInteractionClass = classes.dueDate;
    } else if (due === Due.overdue) {
      lastInteractionClass = classes.overdueDate;
    }
  }

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} sm={noInteractions ? 12 : 6}>
        <FrequencyPicker
          frequency={prayerFrequency}
          fullWidth
          icon={<PrayerIcon />}
          id="prayer"
          label="Prayer Frequency"
          onChange={newFrequency => onChange({ prayerFrequency: newFrequency })}
        />

        {lastPrayerText ? (
          <div className={classes.subscript}>
            {'Last prayed for: '}
            <span className={`${classes.baseDate} ${lastPrayerClass}`}>
              {lastPrayerText}
            </span>
          </div>
        ) : null}
      </Grid>

      {!noInteractions && (
        <Grid item xs={12} sm={6}>
          <FrequencyPicker
            frequency={interactionFrequency}
            fullWidth
            icon={<InteractionIcon />}
            id="frequency"
            label="Interaction Frequency"
            onChange={newFrequency => onChange({ interactionFrequency: newFrequency })}
          />

          {lastInteractionText ? (
            <div className={classes.subscript}>
              {'Last interaction: '}
              <span className={`${classes.baseDate} ${lastInteractionClass}`}>
                {lastInteractionText}
              </span>
            </div>
          ) : null}
        </Grid>
      )}
    </Grid>
  );
}

export default FrequencyControls;
