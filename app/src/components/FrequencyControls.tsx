import { Grid, styled, Typography, FormControl, InputLabel, MenuItem, Select, SelectChangeEvent } from '@mui/material'
import { GroupItem, Item } from '../state/items'
import FrequencyPicker from './FrequencyPicker'
import { Due, isDue } from '../utils/frequencies'
import { FrequencyIcon, PrayerIcon } from './Icons'
import { formatDate } from '../utils'
import InlineText from './InlineText'

type OnChangeData<T extends Item> = Partial<
  { prayerFrequency: T['prayerFrequency'] } & (
    T extends GroupItem ? {
      memberPrayerFrequency: GroupItem['memberPrayerFrequency'],
      memberPrayerTarget: GroupItem['memberPrayerTarget'],
    } : object
  )
>

const TextColorTransition = styled(InlineText)(({ theme }) => ({
  transition: theme.transitions.create('color'),
}))

type PersonProps = {
  lastPrayer?: number
  onChange: (data: OnChangeData<Item>) => void
  prayerFrequency: Item['prayerFrequency']
}

type GroupProps = {
  lastPrayer?: number
  onChange: (data: OnChangeData<GroupItem>) => void
  prayerFrequency: GroupItem['prayerFrequency']
  memberPrayerFrequency: GroupItem['memberPrayerFrequency']
  memberPrayerTarget: GroupItem['memberPrayerTarget']
}

type Props = PersonProps | GroupProps

function FrequencyControls(props: Props) {
  const { lastPrayer, onChange, prayerFrequency } = props
  const isGroup = 'memberPrayerFrequency' in props && props.memberPrayerFrequency !== undefined
  const memberPrayerTarget = isGroup ? (props as GroupProps).memberPrayerTarget : undefined
  const memberPrayerFrequency = isGroup ? (props as GroupProps).memberPrayerFrequency : undefined
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
      {isGroup && (
        <Grid item xs={12} mt={2}>
          <Typography variant="body1" color="text.secondary">
            You can choose how often to pray for the group as a whole,
            and for individual members.
          </Typography>
        </Grid>
      )}

      <Grid item xs={12}>
        <FrequencyPicker
          frequency={prayerFrequency}
          fullWidth
          icon={<PrayerIcon />}
          id="prayer"
          label="Prayer Frequency"
          onChange={newFrequency => onChange({ prayerFrequency: newFrequency })}
        />
      </Grid>
      {isGroup && (
        <>
          <Grid item xs={12} sm={6}>
            <FormControl
              variant="standard"
              sx={{ display: 'flex', flexGrow: 1 }}
            >
              <InputLabel id="member-prayer-target-label">Pray For</InputLabel>
              <Select
                labelId="member-prayer-target-label"
                id="member-prayer-target"
                value={memberPrayerTarget ?? 'one'}
                onChange={(e: SelectChangeEvent<'one'|'all'>) => {
                  (props as GroupProps).onChange({
                    memberPrayerTarget: e.target.value as 'one'|'all',
                  })
                }}
                label="Pray For"
                fullWidth
              >
                <MenuItem value="one">One group member</MenuItem>
                <MenuItem value="all">Every group member</MenuItem>
              </Select>
            </FormControl>
          </Grid>

          <Grid item xs={12} sm={6}>
            <FrequencyPicker
              frequency={memberPrayerFrequency ?? 'none'}
              fullWidth
              icon={<FrequencyIcon />}
              id="memberPrayer"
              label="How often"
              onChange={newFrequency => {
                (props as GroupProps).onChange({
                  memberPrayerFrequency: newFrequency,
                })
              }}
            />
          </Grid>
        </>
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
