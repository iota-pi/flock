import { Grid, styled, Typography } from '@mui/material'
import { GroupItem, Item } from '../state/items'
import FrequencyPicker from './FrequencyPicker'
import { Due, isDue } from '../utils/frequencies'
import { PersonIcon, PrayerIcon } from './Icons'
import { formatDate } from '../utils'
import InlineText from './InlineText'


const TextColorTransition = styled(InlineText)(({ theme }) => ({
  transition: theme.transitions.create('color'),
}))

export interface Props<G extends Item> {
  lastPrayer?: number,
  onChange: <T extends G>(data: Partial<Pick<T, 'prayerFrequency' | 'memberPrayerFrequency'>>) => void,
  prayerFrequency: G['prayerFrequency'],
  memberPrayerFrequency?: G extends GroupItem ? GroupItem['memberPrayerFrequency'] : undefined,
}

function FrequencyControls<G extends Item>({
  lastPrayer,
  onChange,
  prayerFrequency,
  memberPrayerFrequency,
}: Props<G>) {
  const dueColour = 'secondary'
  const overdueColour = 'error'

  let lastPrayerText: string = lastPrayer === undefined ? '' : 'never'
  let lastPrayerClass: string = ''
  if (lastPrayer) {
    lastPrayerText = formatDate(new Date(lastPrayer))
    const due = isDue(new Date(lastPrayer), prayerFrequency)
    if (due === Due.due) {
      lastPrayerClass = dueColour
    } else if (due === Due.overdue) {
      lastPrayerClass = overdueColour
    }
  }

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} sm={memberPrayerFrequency !== undefined ? 6 : 12}>
        <FrequencyPicker
          frequency={prayerFrequency}
          fullWidth
          icon={<PrayerIcon />}
          id="prayer"
          label="Prayer Frequency"
          onChange={newFrequency => onChange({ prayerFrequency: newFrequency })}
        />
      </Grid>

      {memberPrayerFrequency && (
        <Grid item xs={12} sm={6}>
          <FrequencyPicker
            frequency={memberPrayerFrequency}
            fullWidth
            icon={<PersonIcon />}
            id="memberPrayer"
            label="Pray for Members at Least"
            onChange={newFrequency => onChange({ memberPrayerFrequency: newFrequency })}
          />
        </Grid>
      )}

      <Grid item xs={12}>
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
  )
}

export default FrequencyControls
