import { Grid, styled, Typography } from '@mui/material';
import {
  Item, PersonItem,
} from '../state/items';
import FrequencyPicker from './FrequencyPicker';
import { Due, isDue } from '../utils/frequencies';
import { PrayerIcon } from './Icons';
import { formatDate } from '../utils';
import InlineText from './InlineText';


const TextColorTransition = styled(InlineText)(({ theme }) => ({
  transition: theme.transitions.create('color'),
}));

export interface Props {
  lastPrayer: number,
  onChange: (data: Partial<Pick<Item, 'prayerFrequency'>>) => void,
  prayerFrequency: PersonItem['prayerFrequency'],
}

function FrequencyControls({
  lastPrayer,
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

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
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
    </Grid>
  );
}

export default FrequencyControls;
