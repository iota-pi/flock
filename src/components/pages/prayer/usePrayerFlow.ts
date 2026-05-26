import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation } from 'react-router'
import { Item } from '../../../state/items'
import { usePrayerSchedule } from '../../../hooks/usePrayerSchedule'
import { useToday } from '../../../hooks/useToday'
import { recordPrayerCompletion } from '../../../api/vault'
import { isSameDay } from '../../../utils'
import { mutateItem } from '../../../features/items/mutations/itemMutations'
import { type FlowState, usePrayerFlowStore } from '../../../state/prayerFlowStore'

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

function useLatestRef<T>(value: T) {
  const ref = useRef(value)

  useEffect(
    () => {
      ref.current = value
    },
    [value],
  )

  return ref
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
  const prevTodayRef = useRef(today)

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
      if (today.getTime() !== prevTodayRef.current.getTime()) {
        prevTodayRef.current = today
        showOverview()
      }
    },
    [showOverview, today],
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

  const flowRef = useLatestRef(flow)
  const visibleScheduleRef = useLatestRef(visibleSchedule)
  const scheduleRef = useLatestRef(schedule)
  const isPrayedForTodayRef = useLatestRef(isPrayedForToday)
  const showUntilRef = useLatestRef(showUntil)
  const recordPrayerForRef = useLatestRef(recordPrayerFor)
  const completedRef = useLatestRef(completed)
  const allVisiblePrayedRef = useLatestRef(allVisiblePrayed)
  const canKeepPrayingRef = useLatestRef(canKeepPraying)
  const firstUnprayedIndexRef = useLatestRef(firstUnprayedIndex)

  const [actions] = useState<PrayerFlowActions>(
    () => {
      const startAtIndex = (fromIndex: number) => {
        if (!visibleScheduleRef.current[fromIndex]) {
          return
        }

        startAt(fromIndex)
      }

      const keepPraying = () => {
        const nextUnprayed: number[] = []
        const currentVisibleCount = visibleScheduleRef.current.length
        const currentSchedule = scheduleRef.current

        for (let i = currentVisibleCount; i < currentSchedule.length; i++) {
          const item = currentSchedule[i]
          if (item && !isPrayedForTodayRef.current(item)) {
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

        showUntilRef.current(newVisibleCount)
        setActiveIndex(firstNewIndex)
      }

      return {
        handleBack: () => {
          const currentFlow = flowRef.current
          if (currentFlow.type !== 'active') {
            return
          }

          if (currentFlow.index === 0) {
            showOverview()
            return
          }

          setActiveIndex(currentFlow.index - 1)
        },

        handleChange: (data: Partial<Item> | ((prev: Item) => Item)) => {
          const currentFlow = flowRef.current
          if (currentFlow.type !== 'active') {
            return
          }

          const currentItem = visibleScheduleRef.current[currentFlow.index]
          if (!currentItem) {
            return
          }

          if (typeof data === 'function') {
            const nextItem = data(currentItem)
            void mutateItem(currentItem.id, nextItem)
            return
          }

          void mutateItem(currentItem.id, data)
        },

        handleCheck: (item: Item) => {
          recordPrayerForRef.current(item, true)
        },

        handleGoToOverview: () => {
          showOverview()
        },

        handleItemClick: (item: Item) => {
          const index = visibleScheduleRef.current.findIndex(i => i.id === item.id)
          if (index !== -1) {
            startAtIndex(index)
          }
        },

        handleKeepPraying: keepPraying,

        handleNext: () => {
          const currentFlow = flowRef.current
          if (currentFlow.type !== 'active') {
            return
          }

          const currentItem = visibleScheduleRef.current[currentFlow.index]
          if (!currentItem) {
            return
          }

          const prayerTimestamp = Date.now()
          const prayerUpdate = addPrayerForToday(currentItem, prayerTimestamp)
          if (prayerUpdate.addedPrayer) {
            void mutateItem(currentItem.id, { prayedFor: prayerUpdate.prayedFor })
          }

          const nextIndex = currentFlow.index + 1
          if (nextIndex >= visibleScheduleRef.current.length) {
            recordPrayerCompletion(Date.now()).catch(() => {})
            finish(completedRef.current + (prayerUpdate.addedPrayer ? 1 : 0))
            return
          }

          setActiveIndex(nextIndex)
        },

        handleStartFirst: () => {
          if (allVisiblePrayedRef.current && canKeepPrayingRef.current) {
            keepPraying()
            return
          }

          startAtIndex(firstUnprayedIndexRef.current)
        },

        handleStepClick: (index: number) => {
          setActiveIndex(index)
        },
      }
    },
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