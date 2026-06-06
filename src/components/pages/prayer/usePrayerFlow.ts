import {
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useLocation } from 'react-router'
import { Item } from 'src/state/items'
import { usePrayerSchedule } from 'src/hooks/usePrayerSchedule'
import { useToday } from 'src/hooks/useToday'
import { type FlowState, usePrayerFlowStore } from 'src/state/prayerFlowStore'
import { type PrayerFlowActions, usePrayerFlowActions } from './usePrayerFlowActions'
import { ItemId } from 'src/shared/schemas/items'


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
  visibleItemsIds: ItemId[]
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

  const actions = usePrayerFlowActions({
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
  })

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