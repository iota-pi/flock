import { useMemo } from 'react'
import { Item } from 'src/state/items'
import { useEventCallback } from 'src/hooks/useEventCallback'
import { recordPrayerCompletion } from 'src/api/vault'
import { isSameDay } from 'src/utils'
import { mutateItem } from 'src/features/items/mutations/itemMutations'
import { type FlowState } from 'src/state/slices/prayerFlowSlice'
import { SyncBridge } from 'src/sync/client/SyncBridge'
import { useAppStore } from 'src/state/store'

export type PrayerFlowActions = {
  handleBack: () => void
  handleChange: (data: Partial<Item> | ((prev: Item) => Item)) => void
  handleCheck: (item: Item) => void
  handleGoToOverview: () => void
  handleItemClick: (item: Item) => void
  handleKeepPraying: () => void
  handleNext: () => void
  handleStartFirst: () => void
  handleStepClick: (index: number) => void
}

export interface UsePrayerFlowActionsParams {
  flow: FlowState
  visibleSchedule: Item[]
  schedule: Item[]
  isPrayedForToday: (item: Item) => boolean
  showUntil: (count: number) => void
  setActiveIndex: (index: number) => void
  showOverview: () => void
  recordPrayerFor: (item: Item, checked: boolean) => void
  startAt: (index: number) => void
  completed: number
  finish: (completed: number) => void
  allVisiblePrayed: boolean
  canKeepPraying: boolean
  firstUnprayedIndex: number
}

function addPrayerForToday(item: Item, timestamp: number): { addedPrayer: boolean; prayedFor: number[] } {
  const alreadyPrayed = item.prayedFor.some(prayedAt => isSameDay(new Date(prayedAt), new Date(timestamp)))
  if (alreadyPrayed) {
    return { addedPrayer: false, prayedFor: item.prayedFor }
  }

  return {
    addedPrayer: true,
    prayedFor: [...item.prayedFor, timestamp],
  }
}

export function usePrayerFlowActions(params: UsePrayerFlowActionsParams): PrayerFlowActions {
  const {
    flow,
    visibleSchedule,
    schedule,
    isPrayedForToday,
    showUntil,
    setActiveIndex,
    showOverview,
    recordPrayerFor,
    startAt,
    completed,
    finish,
    allVisiblePrayed,
    canKeepPraying,
    firstUnprayedIndex,
  } = params

  const account = useAppStore(state => state.account)

  const startAtIndex = (fromIndex: number) => {
    if (!visibleSchedule[fromIndex]) {
      return
    }
    startAt(fromIndex)
  }

  const handleKeepPraying = useEventCallback(() => {
    const nextUnprayed: number[] = []
    const currentVisibleCount = visibleSchedule.length
    const currentSchedule = schedule

    for (let i = currentVisibleCount; i < currentSchedule.length; i++) {
      const item = currentSchedule[i]
      if (item && !isPrayedForToday(item)) {
        nextUnprayed.push(i)
        if (nextUnprayed.length === 3) {
          break
        }
      }
    }

    if (nextUnprayed.length === 0) {
      return
    }

    const firstNewIndex = nextUnprayed[0]
    const newVisibleCount = nextUnprayed[nextUnprayed.length - 1] + 1

    showUntil(newVisibleCount)
    setActiveIndex(firstNewIndex)
  })

  const handleBack = useEventCallback(() => {
    if (flow.type !== 'active') {
      return
    }

    if (flow.index === 0) {
      showOverview()
      return
    }

    setActiveIndex(flow.index - 1)
  })

  const handleChange = useEventCallback((data: Partial<Item> | ((prev: Item) => Item)) => {
    if (flow.type !== 'active') {
      return
    }

    const currentItem = visibleSchedule[flow.index]
    if (!currentItem) {
      return
    }

    if (typeof data === 'function') {
      const nextItem = data(currentItem)
      void mutateItem(currentItem.id, nextItem)
      return
    }

    void mutateItem(currentItem.id, data)
  })

  const handleCheck = useEventCallback((item: Item) => {
    recordPrayerFor(item, true)
  })

  const handleGoToOverview = useEventCallback(() => {
    showOverview()
  })

  const handleItemClick = useEventCallback((item: Item) => {
    const index = visibleSchedule.findIndex(i => i.id === item.id)
    if (index !== -1) {
      startAtIndex(index)
    }
  })

  const handleNext = useEventCallback(() => {
    if (flow.type !== 'active') {
      return
    }

    const currentItem = visibleSchedule[flow.index]
    if (!currentItem) {
      return
    }

    const prayerTimestamp = Date.now()
    const prayerUpdate = addPrayerForToday(currentItem, prayerTimestamp)
    if (prayerUpdate.addedPrayer) {
      void mutateItem(currentItem.id, { prayedFor: prayerUpdate.prayedFor })
    }

    const nextIndex = flow.index + 1
    if (nextIndex >= visibleSchedule.length) {
      recordPrayerCompletion(account, Date.now()).catch(() => {})
      finish(completed + (prayerUpdate.addedPrayer ? 1 : 0))
      void SyncBridge.forceSync().catch(err => {
        console.error('Failed to trigger forceSync after finishing prayer schedule:', err)
      })
      return
    }

    setActiveIndex(nextIndex)
  })

  const handleStartFirst = useEventCallback(() => {
    if (allVisiblePrayed && canKeepPraying) {
      handleKeepPraying()
      return
    }

    startAtIndex(firstUnprayedIndex)
  })

  const handleStepClick = useEventCallback((index: number) => {
    setActiveIndex(index)
  })

  return useMemo<PrayerFlowActions>(
    () => ({
      handleBack,
      handleChange,
      handleCheck,
      handleGoToOverview,
      handleItemClick,
      handleKeepPraying,
      handleNext,
      handleStartFirst,
      handleStepClick,
    }),
    [
      handleBack,
      handleChange,
      handleCheck,
      handleGoToOverview,
      handleItemClick,
      handleKeepPraying,
      handleNext,
      handleStartFirst,
      handleStepClick,
    ],
  )
}
