import React from 'react';
import {
  Grid, makeStyles,
} from '@material-ui/core';
import {
  Item,
} from '../state/items';
import FrequencyPicker from './FrequencyPicker';
import { Due, Frequency, isDue } from '../utils/frequencies';
import { InteractionIcon, PrayerIcon } from './Icons';
import { getLastPrayedFor } from '../utils/prayer';
import { getLastInteraction } from '../utils/interactions';
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
  item: Item,
  onChange: (key: 'interactionFrequency' | 'prayerFrequency') => (value: Frequency) => void,
}

function FrequencyControls({
  item,
  onChange,
}: Props) {
  const classes = useStyles();
  const lastPrayer = getLastPrayedFor(item);
  const lastInteraction = getLastInteraction(item)?.date;

  let lastPrayerText: string = 'never';
  let lastPrayerClass: string = classes.overdueDate;
  if (lastPrayer) {
    lastPrayerText = formatDate(new Date(lastPrayer));
    const due = isDue(new Date(lastPrayer), item.prayerFrequency);
    if (due === Due.due) {
      lastPrayerClass = classes.dueDate;
    } else if (due === Due.fine) {
      lastPrayerClass = '';
    }
  }

  let lastInteractionText: string = 'never';
  let lastInteractionClass: string = classes.overdueDate;
  if (lastInteraction) {
    lastInteractionText = formatDate(new Date(lastInteraction));
    const due = isDue(new Date(lastInteraction), item.interactionFrequency);
    if (due === Due.due) {
      lastInteractionClass = classes.dueDate;
    } else if (due === Due.fine) {
      lastInteractionClass = '';
    }
  }

  return (
    <>
      <Grid item xs={12} sm={6}>
        <FrequencyPicker
          frequency={item.prayerFrequency}
          onChange={onChange('prayerFrequency')}
          label="Prayer Frequency"
          icon={<PrayerIcon />}
          fullWidth
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

      <Grid item xs={12} sm={6}>
        <FrequencyPicker
          frequency={item.interactionFrequency}
          onChange={onChange('interactionFrequency')}
          label="Interaction Frequency"
          icon={<InteractionIcon />}
          fullWidth
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
    </>
  );
}

export default FrequencyControls;
