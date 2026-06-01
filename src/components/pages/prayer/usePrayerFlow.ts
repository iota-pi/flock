import {
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useLocation } from 'react-router'
import { Item } from 'src/state/items'
import { usePrayerSchedule } from 'src/hooks/usePrayerSchedule'
import { useToday } from 'src/hooks/useToday'
import { useEventCallback } from 'src/hooks/useEventCallback'
import { recordPrayerCompletion } from 'src/api/vault'
import { isSameDay } from 'src/utils'
import { mutateItem } from 'src/features/items/mutations/itemMutations'
import { type FlowState, usePrayerFlowStore } from 'src/state/prayerFlowStore'


type PrayerFlowActions = {
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

type PrayerFlowProgressSlice = {
  allVisiblePrayed: boolean
  canKeepPraying: boolean
  completed: number
  goal: number
  naturalGoal: number
}

type PrayerFlowScheduleSlice = {
  isPrayedForToday: (item: Item) => boolean
  visibleItems: Item[]
  visibleItemsIds: string[]
}

type PrayerFlowViewSlice = {
  activeIndex: number
  current: FlowState
  hideActive: boolean
  isLastActiveStep: boolean
  overlay: FlowState | null
  shouldRenderActive: boolean
  showActiveNavButtons: boolean
  startButtonLabel: string
  trackTransform: string
  transitionDurationMs: number
}

type PrayerFlowStepperSlice = {
  activeStep: number | undefined
  steps: number
}

export type PrayerFlowController = {
  actions: PrayerFlowActions
  progress: PrayerFlowProgressSlice
  schedule: PrayerFlowScheduleSlice
  stepper: PrayerFlowStepperSlice
  view: PrayerFlowViewSlice
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

export default function usePrayerFlow(): PrayerFlowController {
  const location = useLocation()

  const today = useToday()
  const todayTime = today.getTime()
  const prevTodayTimeRef = useRef(todayTime)

  const flow = usePrayerFlowStore(state => state.current)
  const lastOverlay = usePrayerFlowStore(state => state.lastOverlay)
  const showOverview = usePrayerFlowStore(state => state.showOverview)
  const startAt = usePrayerFlowStore(state => state.startAt)
  const setActiveIndex = usePrayerFlowStore(state => state.setActiveIndex)
  const finish = usePrayerFlowStore(state => state.finish)

  const overlayFlow = flow.type !== 'overview' ? flow : lastOverlay

  const {
    completed,
    goal,
    isPrayedForToday,
    naturalGoal,
    recordPrayerFor,
    schedule,
    showUntil,
    visibleSchedule,
    visibleScheduleIds,
  } = usePrayerSchedule()

  const canKeepPraying = useMemo(
    () => schedule.some((item, idx) => idx >= visibleSchedule.length && !isPrayedForToday(item)),
    [isPrayedForToday, schedule, visibleSchedule.length],
  )

  useEffect(
    () => {
      const state = location.state as { resetPrayerAt?: number } | null
      if (state?.resetPrayerAt) {
        showOverview()
      }
    },
    [location.state, showOverview],
  )

  useEffect(
    () => {
      if (todayTime !== prevTodayTimeRef.current) {
        prevTodayTimeRef.current = todayTime
        showOverview()
      }
    },
    [showOverview, todayTime],
  )

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

  const overlayActiveItem = overlayFlow?.type === 'active'
    ? visibleSchedule[overlayFlow.index]
    : undefined
  const showOverlay = flow.type !== 'overview'
  const viewTrackTransform = showOverlay ? 'translateX(-50%)' : 'translateX(0%)'
  const transitionDurationMs = 320
  const shouldPreRenderActive = !overlayFlow && flow.type === 'overview'
  const activeViewIndex = overlayFlow?.type === 'active' ? overlayFlow.index : firstUnprayedIndex
  const activeViewItem = visibleSchedule[activeViewIndex]
  const shouldRenderActiveView = !!overlayActiveItem || (shouldPreRenderActive && !!activeViewItem)
  const hideActiveView = !overlayActiveItem
  const isActiveFlow = flow.type === 'active'
  const stepperSteps = visibleSchedule.length
  const stepperActiveStep = isActiveFlow ? flow.index : undefined
  const showActiveNavButtons = isActiveFlow
  const isLastActiveStep = isActiveFlow && flow.index >= visibleSchedule.length - 1

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
      recordPrayerCompletion(Date.now()).catch(() => {})
      finish(completed + (prayerUpdate.addedPrayer ? 1 : 0))
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

  const actions = useMemo<PrayerFlowActions>(
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

  return {
    actions,
    progress: {
      allVisiblePrayed,
      canKeepPraying,
      completed,
      goal,
      naturalGoal,
    },
    schedule: {
      isPrayedForToday,
      visibleItems: visibleSchedule,
      visibleItemsIds: visibleScheduleIds,
    },
    stepper: {
      activeStep: stepperActiveStep,
      steps: stepperSteps,
    },
    view: {
      activeIndex: activeViewIndex,
      current: flow,
      hideActive: hideActiveView,
      isLastActiveStep,
      overlay: overlayFlow,
      shouldRenderActive: shouldRenderActiveView,
      showActiveNavButtons,
      startButtonLabel,
      trackTransform: viewTrackTransform,
      transitionDurationMs,
    },
  }
}