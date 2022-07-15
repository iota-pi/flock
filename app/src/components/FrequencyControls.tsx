import { Grid, styled, Typography } from '@mui/material';
import {
  Item, PersonItem,
} from '../state/items';
import FrequencyPicker from './FrequencyPicker';
import { Due, isDue } from '../utils/frequencies';
import { InteractionIcon, PrayerIcon } from './Icons';
import { formatDate } from '../utils';
import InlineText from './InlineText';


const TextColorTransition = styled(InlineText)(({ theme }) => ({
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
  const dueColour = 'secondary';
  const overdueColour = 'error';

  let lastPrayerText: string = 'never';
  let lastPrayerClass: string = '';
  if (lastPrayer) {
    lastPrayerText = formatDate(new Date(lastPrayer));
    const due = isDue(new Date(lastPrayer), prayerFrequency);
    if (due === Due.due) {
      lastPrayerClass = dueColour;
    } else if (due === Due.overdue) {
      lastPrayerClass = overdueColour;
    }
  }
  console.log(lastPrayerClass);

  let lastInteractionText: string = 'never';
  let lastInteractionClass: string = '';
  if (lastInteraction) {
    lastInteractionText = formatDate(new Date(lastInteraction));
    const due = isDue(new Date(lastInteraction), interactionFrequency);
    if (due === Due.due) {
      lastInteractionClass = dueColour;
    } else if (due === Due.overdue) {
      lastInteractionClass = overdueColour;
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
          <Typography pt={1} color="text.secondary">
            {'Last prayed for: '}
            <TextColorTransition color={lastPrayerClass}>
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
            <Typography pt={1} color="text.secondary">
              {'Last interaction: '}
              <TextColorTransition color={lastInteractionClass}>
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
