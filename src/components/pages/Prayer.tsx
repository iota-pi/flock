import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Box, Button } from '@mui/material'
import { useLocation } from 'react-router'
import { useSwipeable } from 'react-swipeable'
import {
  cleanItem,
  DirtyItem,
  isItem,
  isValid,
  Item,
} from '../../state/items'
import { useItemMap } from '../../state/selectors'
import { usePrayerSchedule } from '../../hooks/usePrayerSchedule'
import { useStoreItemsMutation } from '../../api/queries'
import { recordPrayerCompletion } from '../../api/VaultLazy'
import ItemList, { ItemListExtraElement } from '../ItemList'
import GoalDialog from '../dialogs/GoalDialog'
import BasePage from './BasePage'
import { isSameDay } from '../../utils'
import { getLastPrayedFor } from '../../utils/prayer'
import PrayerActiveView from './prayer/PrayerActiveView'
import PrayerFinishedView from './prayer/PrayerFinishedView'
import PrayerOverviewHeader from './prayer/PrayerOverviewHeader'
import PrayerStepper from './prayer/PrayerStepper'
import { NextIcon } from '../Icons'


type FlowState =
  | { type: 'overview' }
  | { type: 'active'; index: number }
  | { type: 'finished'; prayedCount: number }


function PrayerPage() {
  const location = useLocation()
  const itemMap = useItemMap()
  const { mutate: storeItems } = useStoreItemsMutation()

  const [flow, setFlow] = useState<FlowState>({ type: 'overview' })
  const [localItems, setLocalItems] = useState<DirtyItem<Item>[]>([])
  const [showGoalDialog, setShowGoalDialog] = useState(false)
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false)

  const {
    completed,
    goal,
    isPrayedForToday,
    naturalGoal,
    recordPrayerFor,
    schedule,
    scheduleIds,
    showUntil,
    visibleSchedule,
  } = usePrayerSchedule()

  const canKeepPraying = useMemo(
    () => schedule.some((item, idx) => idx >= visibleSchedule.length && !isPrayedForToday(item)),
    [isPrayedForToday, schedule, visibleSchedule.length],
  )

  useEffect(
    () => {
      const state = location.state as { resetPrayerAt?: number } | null
      if (state?.resetPrayerAt) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFlow({ type: 'overview' })
        setIsEditDrawerOpen(false)
      }
    },
    [location.state],
  )

  const buildLocalItems = useCallback(
    (count: number) => (
      scheduleIds
        .slice(0, count)
        .map(id => itemMap[id])
        .filter((item): item is Item => !!item)
        .map(item => ({ ...item }) as DirtyItem<Item>)
    ),
    [itemMap, scheduleIds],
  )

  const handleChange = useCallback(
    <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => {
      setLocalItems(prevItems => {
        if (flow.type !== 'active') return prevItems
        const activeItem = prevItems[flow.index]
        if (!activeItem) return prevItems

        if (typeof data === 'function') {
          const nextItem = { ...data(activeItem), dirty: true } as DirtyItem<Item>
          const nextItems = [...prevItems]
          nextItems[flow.index] = nextItem
          return nextItems
        }

        const nextItems = [...prevItems]
        nextItems[flow.index] = { ...activeItem, ...data, dirty: true } as DirtyItem<Item>
        return nextItems
      })
    },
    [flow],
  )

  const handleEditDrawerChange = useCallback(
    (
      data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
    ) => {
      setLocalItems(prevItems => {
        if (flow.type !== 'active') {
          return prevItems
        }
        const activeItem = prevItems[flow.index]
        if (!activeItem) return prevItems

        if (typeof data === 'function') {
          const nextItems = [...prevItems]
          nextItems[flow.index] = data(activeItem) as DirtyItem<Item>
          return nextItems
        }
        const nextItems = [...prevItems]
        nextItems[flow.index] = {
          ...activeItem,
          ...data,
        } as DirtyItem<Item>
        return nextItems
      })
    },
    [flow],
  )

  const saveLocalItem = useCallback(
    (currentItem: DirtyItem<Item>) => {
      if ((currentItem.dirty || currentItem.isNew) && isValid(currentItem)) {
        const clean = cleanItem(currentItem)
        if (isItem(clean)) {
          storeItems(clean)
        }
      }
    },
    [storeItems],
  )

  const recordPrayedForLocalItem = useCallback(
    (currentItem: DirtyItem<Item>): DirtyItem<Item> => {
      const lastPrayer = getLastPrayedFor(currentItem)
      const alreadyPrayed = isSameDay(new Date(), new Date(lastPrayer))
      if (alreadyPrayed) return currentItem
      const prayedFor = [...currentItem.prayedFor, new Date().getTime()]
      return { ...currentItem, prayedFor, dirty: true }
    },
    [],
  )

  const handleStart = useCallback(
    (fromIndex: number) => {
      const items = buildLocalItems(visibleSchedule.length)
      if (!items[fromIndex]) return
      setLocalItems(items)
      setFlow({ type: 'active', index: fromIndex })
    },
    [buildLocalItems, visibleSchedule.length],
  )

  const handleNext = useCallback(
    () => {
      if (flow.type !== 'active') return
      const currentItem = localItems[flow.index]
      if (!currentItem) return

      const alreadyPrayedToday = isSameDay(new Date(), new Date(getLastPrayedFor(currentItem)))
      const withPrayer = recordPrayedForLocalItem(currentItem)
      setLocalItems(prevItems => {
        const nextItems = [...prevItems]
        nextItems[flow.index] = withPrayer
        return nextItems
      })
      saveLocalItem(withPrayer)

      const nextIndex = flow.index + 1
      if (nextIndex >= localItems.length) {
        const completedAt = Date.now()
        recordPrayerCompletion(completedAt).catch(() => {})
        setFlow({
          type: 'finished',
          prayedCount: completed + (alreadyPrayedToday ? 0 : 1),
        })
      } else {
        setFlow({ type: 'active', index: nextIndex })
      }
    },
    [completed, flow, localItems, recordPrayedForLocalItem, saveLocalItem],
  )

  const handleBack = useCallback(
    () => {
      if (flow.type !== 'active') return
      const currentItem = localItems[flow.index]
      if (!currentItem) return

      saveLocalItem(currentItem)

      if (flow.index === 0) {
        setFlow({ type: 'overview' })
      } else {
        setFlow({ type: 'active', index: flow.index - 1 })
      }
    },
    [flow, localItems, saveLocalItem],
  )

  const handleStepClick = useCallback(
    (index: number) => {
      if (flow.type !== 'active') return
      const currentItem = localItems[flow.index]
      if (!currentItem) return
      saveLocalItem(currentItem)
      setFlow({ type: 'active', index })
    },
    [flow, localItems, saveLocalItem],
  )

  const handleItemClick = useCallback(
    (item: Item) => {
      const index = visibleSchedule.findIndex(s => s.id === item.id)
      if (index >= 0) {
        handleStart(index)
      }
    },
    [visibleSchedule, handleStart],
  )

  const handleCheck = useCallback(
    (item: Item) => recordPrayerFor(item, true),
    [recordPrayerFor],
  )

  const handleKeepPraying = useCallback(
    () => {
      const nextUnprayed: number[] = []
      for (let i = visibleSchedule.length; i < schedule.length; i++) {
        const item = schedule[i]
        if (item && !isPrayedForToday(item)) {
          nextUnprayed.push(i)
          if (nextUnprayed.length === 3) break
        }
      }
      if (nextUnprayed.length === 0) return

      const firstNewIndex = nextUnprayed[0]
      const newVisibleCount = nextUnprayed[nextUnprayed.length - 1] + 1
      showUntil(newVisibleCount)
      const expandedItems = buildLocalItems(newVisibleCount)
      setLocalItems(expandedItems)
      setFlow({ type: 'active', index: firstNewIndex })
    },
    [buildLocalItems, isPrayedForToday, schedule, showUntil, visibleSchedule.length],
  )

  const handleEditGoal = useCallback(() => setShowGoalDialog(true), [])
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), [])
  const handleOpenEditDrawer = useCallback(() => setIsEditDrawerOpen(true), [])
  const handleCloseEditDrawer = useCallback(() => setIsEditDrawerOpen(false), [])
  const firstUnprayedIndex = useMemo(
    () => {
      const index = visibleSchedule.findIndex(item => !isPrayedForToday(item))
      return index >= 0 ? index : 0
    },
    [isPrayedForToday, visibleSchedule],
  )
  const hasPrayedItems = useMemo(
    () => visibleSchedule.some(isPrayedForToday),
    [isPrayedForToday, visibleSchedule],
  )
  const allVisiblePrayed = useMemo(
    () => visibleSchedule.length > 0 && visibleSchedule.every(isPrayedForToday),
    [isPrayedForToday, visibleSchedule],
  )
  const startButtonLabel = allVisiblePrayed ? 'Keep Praying' : (hasPrayedItems ? 'Continue' : 'Start')
  const handleOverviewPrimaryAction = useCallback(
    () => {
      if (allVisiblePrayed && canKeepPraying) {
        handleKeepPraying()
      } else {
        handleStart(firstUnprayedIndex)
      }
    },
    [allVisiblePrayed, canKeepPraying, firstUnprayedIndex, handleKeepPraying, handleStart],
  )
  const handleStartFirst = useCallback(
    () => handleOverviewPrimaryAction(),
    [handleOverviewPrimaryAction],
  )

  const overviewSwipeHandlers = useSwipeable({
    delta: 60,
    onSwiped: ({ deltaX, deltaY }) => {
      if (visibleSchedule.length === 0) return
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return
      if (deltaX < 0) {
        handleStartFirst()
      }
    },
    preventScrollOnSwipe: false,
    trackMouse: false,
    trackTouch: true,
  })

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <PrayerOverviewHeader
            completed={completed}
            goal={goal}
            naturalGoal={naturalGoal}
            onEditGoal={handleEditGoal}
            onStart={handleStartFirst}
            startDisabled={allVisiblePrayed && !canKeepPraying}
            startLabel={startButtonLabel}
            visibleScheduleLength={visibleSchedule.length}
          />
        ),
        index: 0,
      },
    ],
    [
      allVisiblePrayed,
      canKeepPraying,
      completed,
      goal,
      handleEditGoal,
      handleStartFirst,
      naturalGoal,
      startButtonLabel,
      visibleSchedule.length,
    ],
  )

  const activeItem = flow.type === 'active' ? localItems[flow.index] : undefined

  if (flow.type === 'active' && activeItem) {
    return (
      <PrayerActiveView
        activeIndex={flow.index}
        items={localItems}
        isEditDrawerOpen={isEditDrawerOpen && flow.type === 'active'}
        onBack={handleBack}
        onCloseEditDrawer={handleCloseEditDrawer}
        onEditDrawerChange={handleEditDrawerChange}
        onItemChange={handleChange}
        onNext={handleNext}
        onOpenEditDrawer={handleOpenEditDrawer}
        onStepClick={handleStepClick}
        totalSteps={localItems.length}
      />
    )
  }

  if (flow.type === 'finished') {
    return (
      <PrayerFinishedView
        canKeepPraying={canKeepPraying}
        onBackToOverview={() => setFlow({ type: 'overview' })}
        onKeepPraying={handleKeepPraying}
        prayedCount={flow.prayedCount}
      />
    )
  }

  return (
    <BasePage noScrollContainer>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box {...overviewSwipeHandlers} sx={{ flexGrow: 1, minHeight: 0 }}>
          <ItemList
            checkboxes
            checkboxSide="right"
            extraElements={extraElements}
            getChecked={isPrayedForToday}
            getForceFade={isPrayedForToday}
            items={visibleSchedule}
            noItemsText="No items in prayer schedule"
            onCheck={handleCheck}
            onClick={handleItemClick}
            showIcons
            showTags={false}
          />
        </Box>

        <PrayerStepper
          steps={visibleSchedule.length}
          nextButton={(
            <Button
              disabled={allVisiblePrayed && !canKeepPraying}
              endIcon={<NextIcon />}
              onClick={handleStartFirst}
            >
              {startButtonLabel}
            </Button>
          )}
        />
      </Box>

      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />
    </BasePage>
  )
}

export default PrayerPage
