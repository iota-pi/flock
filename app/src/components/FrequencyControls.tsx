import { Grid, styled, Typography } from '@mui/material';
import {
  Item, PersonItem,
} from '../state/items';
import FrequencyPicker from './FrequencyPicker';
import { Due, isDue } from '../utils/frequencies';
import { InteractionIcon, PrayerIcon } from './Icons';
import { formatDate } from '../utils';


const TextColorTransition = styled('span')(({ theme }) => ({
  transition: theme.transitions.create('color'),
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
  const dueClass = 'secondary';
  const overdueClass = 'main';

  let lastPrayerText: string = 'never';
  let lastPrayerClass: string = '';
  if (lastPrayer) {
    lastPrayerText = formatDate(new Date(lastPrayer));
    const due = isDue(new Date(lastPrayer), prayerFrequency);
    if (due === Due.due) {
      lastPrayerClass = dueClass;
    } else if (due === Due.overdue) {
      lastPrayerClass = overdueClass;
    }
  }

  let lastInteractionText: string = 'never';
  let lastInteractionClass: string = '';
  if (lastInteraction) {
    lastInteractionText = formatDate(new Date(lastInteraction));
    const due = isDue(new Date(lastInteraction), interactionFrequency);
    if (due === Due.due) {
      lastInteractionClass = dueClass;
    } else if (due === Due.overdue) {
      lastInteractionClass = overdueClass;
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
          <Typography pt={1} color="secondary">
            {'Last prayed for: '}
            <TextColorTransition className={lastPrayerClass}>
              {lastPrayerText}
            </TextColorTransition>
          </Typography>
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
            <Typography pt={1} color="secondary">
              {'Last interaction: '}
              <TextColorTransition className={lastInteractionClass}>
                {lastInteractionText}
              </TextColorTransition>
            </Typography>
          ) : null}
        </Grid>
      )}
    </Grid>
  );
}

export default FrequencyControls;
