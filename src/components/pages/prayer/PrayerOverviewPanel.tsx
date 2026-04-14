import { Box } from '@mui/material'
import { useSwipeable } from 'react-swipeable'
import type { Item } from '../../../state/items'
import ItemList from '../../../features/items/components/ItemList'
import PrayerOverviewHeader from './PrayerOverviewHeader'

type Props = {
  completed: number,
  goal: number,
  naturalGoal: number,
  visibleSchedule: Item[],
  startLabel: string,
  startDisabled: boolean,
  onEditGoal: () => void,
  onStart: () => void,
  onItemClick: (item: Item) => void,
  onCheck: (item: Item) => void,
  isPrayedForToday: (item: Item) => boolean,
}

function PrayerOverviewPanel({
  completed,
  goal,
  naturalGoal,
  visibleSchedule,
  startLabel,
  startDisabled,
  onEditGoal,
  onStart,
  onItemClick,
  onCheck,
  isPrayedForToday,
}: Props) {
  const overviewSwipeHandlers = useSwipeable({
    delta: 60,
    onSwiped: ({ deltaX, deltaY }) => {
      if (visibleSchedule.length === 0) return
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return
      if (deltaX < 0) {
        onStart()
      }
    },
    preventScrollOnSwipe: false,
    trackMouse: false,
    trackTouch: true,
  })

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, width: '50%' }}>
      <div>
        <PrayerOverviewHeader
          completed={completed}
          goal={goal}
          naturalGoal={naturalGoal}
          onEditGoal={onEditGoal}
          onStart={onStart}
          startDisabled={startDisabled}
          startLabel={startLabel}
          visibleScheduleLength={visibleSchedule.length}
        />
      </div>

      <Box {...overviewSwipeHandlers} sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        <ItemList
          checkboxes
          checkboxSide="right"
          getChecked={isPrayedForToday}
          getForceFade={isPrayedForToday}
          items={visibleSchedule}
          noItemsText="No items in prayer schedule"
          onCheck={onCheck}
          onClick={onItemClick}
          showIcons
          showTags={false}
        />
      </Box>
    </Box>
  )
}

export default PrayerOverviewPanel
