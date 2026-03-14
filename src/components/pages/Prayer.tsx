import {
  TouchEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '@mui/material'
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
import ItemList, { ItemListExtraElement } from '../ItemList'
import { NextIcon } from '../Icons'
import GoalDialog from '../dialogs/GoalDialog'
import BasePage from './BasePage'
import { isSameDay } from '../../utils'
import { getLastPrayedFor } from '../../utils/prayer'
import PrayerActiveView from './prayer/PrayerActiveView'
import PrayerFinishedView from './prayer/PrayerFinishedView'
import PrayerOverviewHeader from './prayer/PrayerOverviewHeader'


type FlowState =
  | { type: 'overview' }
  | { type: 'active'; index: number }
  | { type: 'finished'; prayedCount: number }


function PrayerPage() {
  const itemMap = useItemMap()
  const { mutate: storeItems } = useStoreItemsMutation()

  const [flow, setFlow] = useState<FlowState>({ type: 'overview' })
  const [localItem, setLocalItem] = useState<DirtyItem<Item> | null>(null)
  const [showGoalDialog, setShowGoalDialog] = useState(false)
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false)

  const touchStart = useRef<{ x: number; y: number } | null>(null)

  const {
    completed,
    goal,
    isPrayedForToday,
    naturalGoal,
    recordPrayerFor,
    scheduleIds,
    showMore,
    visibleSchedule,
  } = usePrayerSchedule()

  const canKeepPraying = visibleSchedule.length < scheduleIds.length

  const handleChange = useCallback(
    <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => {
      setLocalItem(prev => {
        if (!prev) return prev
        if (typeof data === 'function') {
          return { ...data(prev), dirty: true } as DirtyItem<Item>
        }
        return { ...prev, ...data, dirty: true } as DirtyItem<Item>
      })
    },
    [],
  )

  const handleEditDrawerChange = useCallback(
    (
      data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
    ) => {
      setLocalItem(prevItem => {
        if (!prevItem) {
          return prevItem
        }
        if (typeof data === 'function') {
          return data(prevItem) as DirtyItem<Item>
        }
        return {
          ...prevItem,
          ...data,
        } as DirtyItem<Item>
      })
    },
    [],
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
      const schedItem = visibleSchedule[fromIndex]
      if (!schedItem) return
      const fullItem = itemMap[schedItem.id] ?? schedItem
      setLocalItem({ ...fullItem } as DirtyItem<Item>)
      setFlow({ type: 'active', index: fromIndex })
    },
    [itemMap, visibleSchedule],
  )

  const handleNext = useCallback(
    () => {
      if (flow.type !== 'active' || !localItem) return
      const alreadyPrayedToday = isSameDay(new Date(), new Date(getLastPrayedFor(localItem)))
      const withPrayer = recordPrayedForLocalItem(localItem)
      saveLocalItem(withPrayer)

      const nextIndex = flow.index + 1
      if (nextIndex >= visibleSchedule.length) {
        setLocalItem(null)
        setFlow({
          type: 'finished',
          prayedCount: completed + (alreadyPrayedToday ? 0 : 1),
        })
      } else {
        const nextScheduleItem = visibleSchedule[nextIndex]
        const nextFullItem = itemMap[nextScheduleItem.id] ?? nextScheduleItem
        setLocalItem({ ...nextFullItem } as DirtyItem<Item>)
        setFlow({ type: 'active', index: nextIndex })
      }
    },
    [flow, localItem, recordPrayedForLocalItem, saveLocalItem, visibleSchedule, itemMap, completed],
  )

  const handleBack = useCallback(
    () => {
      if (flow.type !== 'active' || !localItem) return
      saveLocalItem(localItem)

      if (flow.index === 0) {
        setLocalItem(null)
        setFlow({ type: 'overview' })
      } else {
        const prevIndex = flow.index - 1
        const prevScheduleItem = visibleSchedule[prevIndex]
        const prevFullItem = itemMap[prevScheduleItem.id] ?? prevScheduleItem
        setLocalItem({ ...prevFullItem } as DirtyItem<Item>)
        setFlow({ type: 'active', index: prevIndex })
      }
    },
    [flow, localItem, saveLocalItem, visibleSchedule, itemMap],
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
      if (!canKeepPraying) return
      const nextIndex = visibleSchedule.length
      const nextItemId = scheduleIds[nextIndex]
      const nextItem = nextItemId ? itemMap[nextItemId] : undefined
      if (!nextItem) {
        return
      }

      showMore()
      setLocalItem({ ...nextItem } as DirtyItem<Item>)
      setFlow({ type: 'active', index: nextIndex })
    },
    [canKeepPraying, itemMap, scheduleIds, showMore, visibleSchedule.length],
  )

  const handleEditGoal = useCallback(() => setShowGoalDialog(true), [])
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), [])
  const handleOpenEditDrawer = useCallback(() => setIsEditDrawerOpen(true), [])
  const handleCloseEditDrawer = useCallback(() => setIsEditDrawerOpen(false), [])

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    },
    [],
  )

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (!touchStart.current) return
      const deltaX = e.changedTouches[0].clientX - touchStart.current.x
      const deltaY = e.changedTouches[0].clientY - touchStart.current.y
      touchStart.current = null
      if (Math.abs(deltaX) < 60) return
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return
      if (deltaX < 0) {
        handleNext()
      } else {
        handleBack()
      }
    },
    [handleNext, handleBack],
  )

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <PrayerOverviewHeader
            completed={completed}
            goal={goal}
            naturalGoal={naturalGoal}
            onEditGoal={handleEditGoal}
            onStart={() => handleStart(0)}
            visibleScheduleLength={visibleSchedule.length}
          />
        ),
        index: 0,
      },
    ],
    [completed, goal, handleEditGoal, handleStart, naturalGoal, visibleSchedule.length],
  )

  if (flow.type === 'active' && localItem) {
    return (
      <PrayerActiveView
        index={flow.index}
        isEditDrawerOpen={isEditDrawerOpen && flow.type === 'active'}
        localItem={localItem}
        onBack={handleBack}
        onCloseEditDrawer={handleCloseEditDrawer}
        onEditDrawerChange={handleEditDrawerChange}
        onItemChange={handleChange}
        onNext={handleNext}
        onOpenEditDrawer={handleOpenEditDrawer}
        onTouchEnd={handleTouchEnd}
        onTouchStart={handleTouchStart}
        totalSteps={visibleSchedule.length}
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

      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />
    </BasePage>
  )
}

export default PrayerPage
