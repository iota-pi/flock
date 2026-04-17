import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useLocation } from 'react-router'
import {
  DirtyItem,
  Item,
} from '../../../state/items'
import { usePrayerSchedule } from '../../../hooks/usePrayerSchedule'
import { useToday } from '../../../hooks/useToday'
import { recordPrayerCompletion } from '../../../api/vault'
import {
  applyPrayerToItem,
  type FlowState,
  PRAYER_FLOW_INITIAL_STATE,
  prayerFlowReducer,
} from './prayerFlowReducer'
import usePrayerSync from './usePrayerSync'

export type PrayerFlowActions = {
  handleBack: () => void
  handleChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => void
  handleCheck: (item: Item) => void
  handleCloseEditDrawer: () => void
  handleEditDrawerChange: (
    data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
  ) => void
  handleGoToOverview: () => void
  handleItemClick: (item: Item) => void
  handleKeepPraying: () => void
  handleNext: () => void
  handleStartFirst: () => void
  handleStepClick: (index: number) => void
}

export type PrayerFlowProgressSlice = {
  allVisiblePrayed: boolean
  canKeepPraying: boolean
  completed: number
  goal: number
  naturalGoal: number
}

export type PrayerFlowScheduleSlice = {
  isPrayedForToday: (item: Item) => boolean
  localItems: DirtyItem<Item>[]
  visibleItems: Item[]
}

export type PrayerFlowViewSlice = {
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

export type PrayerFlowStepperSlice = {
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

export default function usePrayerFlow(): PrayerFlowController {
  const location = useLocation()
  const { queuePrayedForSync, saveLocalItem } = usePrayerSync()

  const today = useToday()
  const prevTodayRef = useRef(today)

  const [flowState, dispatchFlow] = useReducer(prayerFlowReducer, PRAYER_FLOW_INITIAL_STATE)
  const flow = flowState.current
  const localItems = flowState.localItems

  const overlayFlow = flow.type !== 'overview' ? flow : flowState.lastOverlay

  const {
    completed,
    goal,
    isPrayedForToday,
    naturalGoal,
    recordPrayerFor,
    schedule,
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
        dispatchFlow({ type: 'show-overview' })
      }
    },
    [location.state],
  )

  useEffect(
    () => {
      if (today.getTime() !== prevTodayRef.current.getTime()) {
        prevTodayRef.current = today
        dispatchFlow({ type: 'show-overview' })
        dispatchFlow({ type: 'clear-local-items' })
      }
    },
    [today],
  )

  const isActiveViewPrepared = true

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

  const overlayActiveItem = overlayFlow?.type === 'active' ? localItems[overlayFlow.index] : undefined
  const showOverlay = flow.type !== 'overview'
  const viewTrackTransform = showOverlay ? 'translateX(-50%)' : 'translateX(0%)'
  const transitionDurationMs = isActiveViewPrepared ? 320 : 360
  const shouldPreRenderActive = !overlayFlow && flow.type === 'overview' && isActiveViewPrepared
  const activeViewIndex = overlayFlow?.type === 'active' ? overlayFlow.index : firstUnprayedIndex
  const activeViewItem = localItems[activeViewIndex]
  const shouldRenderActiveView = !!overlayActiveItem || (shouldPreRenderActive && !!activeViewItem)
  const hideActiveView = !overlayActiveItem
  const isActiveFlow = flow.type === 'active'
  const isFinishedFlow = flow.type === 'finished'
  const stepperSteps = isActiveFlow || isFinishedFlow ? localItems.length : visibleSchedule.length
  const stepperActiveStep = isActiveFlow ? flow.index : undefined
  const showActiveNavButtons = isActiveFlow
  const isLastActiveStep = isActiveFlow && flow.index >= localItems.length - 1

  const flowRef = useLatestRef(flow)
  const localItemsRef = useLatestRef(localItems)
  const visibleScheduleRef = useLatestRef(visibleSchedule)
  const scheduleRef = useLatestRef(schedule)
  const isPrayedForTodayRef = useLatestRef(isPrayedForToday)
  const showUntilRef = useLatestRef(showUntil)
  const recordPrayerForRef = useLatestRef(recordPrayerFor)
  const queuePrayedForSyncRef = useLatestRef(queuePrayedForSync)
  const saveLocalItemRef = useLatestRef(saveLocalItem)
  const completedRef = useLatestRef(completed)
  const allVisiblePrayedRef = useLatestRef(allVisiblePrayed)
  const canKeepPrayingRef = useLatestRef(canKeepPraying)
  const firstUnprayedIndexRef = useLatestRef(firstUnprayedIndex)

  const [actions] = useState<PrayerFlowActions>(
    () => {
      const buildLocalItems = (count: number): DirtyItem<Item>[] => (
        scheduleRef.current
          .slice(0, count)
          .map(item => ({ ...item }) as DirtyItem<Item>)
      )

      const startAtIndex = (fromIndex: number) => {
        const existingItems = localItemsRef.current
        const visibleCount = visibleScheduleRef.current.length
        const items = existingItems.length > 0 ? existingItems : buildLocalItems(visibleCount)

        if (!items[fromIndex]) {
          return
        }

        if (items !== existingItems) {
          dispatchFlow({ type: 'set-local-items', items })
        }

        dispatchFlow({ type: 'start-at', index: fromIndex })
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
        dispatchFlow({
          type: 'set-local-items',
          items: buildLocalItems(newVisibleCount),
        })
        dispatchFlow({ type: 'set-active-index', index: firstNewIndex })
      }

      return {
        handleBack: () => {
          const currentFlow = flowRef.current
          if (currentFlow.type !== 'active') {
            return
          }

          if (currentFlow.index === 0) {
            dispatchFlow({ type: 'show-overview' })
            return
          }

          dispatchFlow({ type: 'set-active-index', index: currentFlow.index - 1 })
        },

        handleChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => {
          const currentFlow = flowRef.current
          if (currentFlow.type !== 'active') {
            return
          }

          const currentItem = localItemsRef.current[currentFlow.index]
          if (!currentItem) {
            return
          }

          if (typeof data === 'function') {
            dispatchFlow({
              type: 'replace-item',
              index: currentFlow.index,
              item: { ...data(currentItem), dirty: true } as DirtyItem<Item>,
            })
            return
          }

          dispatchFlow({
            type: 'edit-item',
            index: currentFlow.index,
            changes: data as Partial<DirtyItem<Item>>,
            markDirty: true,
          })
        },

        handleCheck: (item: Item) => {
          recordPrayerForRef.current(item, true)
        },

        handleCloseEditDrawer: () => {
          const currentFlow = flowRef.current
          if (currentFlow.type !== 'active') {
            return
          }

          const currentItem = localItemsRef.current[currentFlow.index]
          if (!currentItem) {
            return
          }

          const existing = scheduleRef.current.find(item => item.id === currentItem.id)
          const prayedForChanged = (
            !!existing
            && JSON.stringify(existing.prayedFor) !== JSON.stringify(currentItem.prayedFor)
          )

          if (prayedForChanged) {
            queuePrayedForSyncRef.current(currentItem)
          } else {
            saveLocalItemRef.current(currentItem)
          }
        },

        handleEditDrawerChange: (
          data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
        ) => {
          const currentFlow = flowRef.current
          if (currentFlow.type !== 'active') {
            return
          }

          const currentItem = localItemsRef.current[currentFlow.index]
          if (!currentItem) {
            return
          }

          if (typeof data === 'function') {
            dispatchFlow({
              type: 'replace-item',
              index: currentFlow.index,
              item: data(currentItem) as DirtyItem<Item>,
            })
            return
          }

          dispatchFlow({
            type: 'edit-item',
            index: currentFlow.index,
            changes: data as Partial<DirtyItem<Item>>,
          })
        },

        handleGoToOverview: () => {
          dispatchFlow({ type: 'show-overview' })
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

          const currentItem = localItemsRef.current[currentFlow.index]
          if (!currentItem) {
            return
          }

          const prayerTimestamp = Date.now()
          const prayerUpdate = applyPrayerToItem(currentItem, prayerTimestamp)

          dispatchFlow({
            type: 'record-prayer',
            index: currentFlow.index,
            timestamp: prayerTimestamp,
          })
          queuePrayedForSyncRef.current(prayerUpdate.item)

          const nextIndex = currentFlow.index + 1
          if (nextIndex >= localItemsRef.current.length) {
            recordPrayerCompletion(Date.now()).catch(() => {})
            dispatchFlow({
              type: 'finish',
              prayedCount: completedRef.current + (prayerUpdate.addedPrayer ? 1 : 0),
            })
            return
          }

          dispatchFlow({ type: 'set-active-index', index: nextIndex })
        },

        handleStartFirst: () => {
          if (allVisiblePrayedRef.current && canKeepPrayingRef.current) {
            keepPraying()
            return
          }

          startAtIndex(firstUnprayedIndexRef.current)
        },

        handleStepClick: (index: number) => {
          dispatchFlow({ type: 'set-active-index', index })
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
      localItems,
      visibleItems: visibleSchedule,
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