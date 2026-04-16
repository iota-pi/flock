/* eslint-disable react-hooks/set-state-in-effect */
import {
  useCallback,
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
import { useDialogState } from '../../../hooks/useDialogState'
import { isSameDay } from '../../../utils'
import { getLastPrayedFor } from '../../../utils/prayer'
import {
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
  handleCloseGoalDialog: () => void
  handleEditDrawerChange: (
    data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
  ) => void
  handleEditGoal: () => void
  handleGoToOverview: () => void
  handleItemClick: (item: Item) => void
  handleKeepPraying: () => void
  handleNext: () => void
  handleOpenEditDrawer: () => void
  handleStartFirst: () => void
  handleStepClick: (index: number) => void
}

export type PrayerFlowStateView = {
  allVisiblePrayed: boolean
  canKeepPraying: boolean
  completed: number
  firstUnprayedIndex: number
  flow: FlowState
  goal: number
  hideActiveView: boolean
  isLastActiveStep: boolean
  isPrayedForToday: (item: Item) => boolean
  localItems: DirtyItem<Item>[]
  naturalGoal: number
  overlayFlow: FlowState | null
  shouldRenderActiveView: boolean
  showActiveNavButtons: boolean
  startButtonLabel: string
  stepperActiveStep: number | undefined
  stepperSteps: number
  transitionDurationMs: number
  viewTrackTransform: string
  visibleSchedule: Item[]
  activeViewIndex: number
}

export type PrayerFlowUi = {
  isEditDrawerOpen: boolean
  isGoalDialogOpen: boolean
}

export type PrayerFlowController = {
  actions: PrayerFlowActions
  state: PrayerFlowStateView
  ui: PrayerFlowUi
}

export default function usePrayerFlow(): PrayerFlowController {
  const location = useLocation()
  const { queuePrayedForSync, saveLocalItem } = usePrayerSync()

  const today = useToday()
  const prevTodayRef = useRef(today)

  const [flowState, dispatchFlow] = useReducer(prayerFlowReducer, PRAYER_FLOW_INITIAL_STATE)
  const localItems = flowState.localItems
  const {
    closeDialog: closeGoalDialog,
    isOpen: isGoalDialogOpen,
    openDialog: openGoalDialog,
  } = useDialogState('goal')
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false)
  const flow = flowState.current

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
        setIsEditDrawerOpen(false)
      }
    },
    [location.state],
  )

  useEffect(
    () => {
      if (today.getTime() !== prevTodayRef.current.getTime()) {
        prevTodayRef.current = today
        dispatchFlow({ type: 'show-overview' })
        dispatchFlow({ type: 'set-local-items', items: [] })
        setIsEditDrawerOpen(false)
      }
    },
    [today],
  )

  const buildLocalItems = useCallback(
    (count: number) => (
      schedule
        .slice(0, count)
        .map(item => ({ ...item }) as DirtyItem<Item>)
    ),
    [schedule],
  )

  const visibleIndexByItemId = useMemo(
    () => {
      const indexById = new Map<string, number>()
      for (let index = 0; index < visibleSchedule.length; index += 1) {
        indexById.set(visibleSchedule[index].id, index)
      }

      return indexById
    },
    [visibleSchedule],
  )

  const isActiveViewPrepared = true

  const handleChange = useCallback(
    <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => {
      dispatchFlow({
        type: 'update-local-items',
        updater: prevItems => {
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
        },
      })
    },
    [flow],
  )

  const handleEditDrawerChange = useCallback(
    (
      data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
    ) => {
      dispatchFlow({
        type: 'update-local-items',
        updater: prevItems => {
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
        },
      })
    },
    [flow],
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
      const existingItems = localItems
      const visibleCount = visibleSchedule.length
      const items = existingItems.length > 0 ? existingItems : buildLocalItems(visibleCount)
      if (!items[fromIndex]) return
      if (items !== existingItems) {
        dispatchFlow({ type: 'set-local-items', items })
      }
      dispatchFlow({ type: 'start-at', index: fromIndex })
    },
    [buildLocalItems, localItems, visibleSchedule.length],
  )

  const handleNext = useCallback(
    () => {
      if (flow.type !== 'active') return
      const currentItem = localItems[flow.index]
      if (!currentItem) return

      const alreadyPrayedToday = isSameDay(new Date(), new Date(getLastPrayedFor(currentItem)))
      const withPrayer = recordPrayedForLocalItem(currentItem)
      dispatchFlow({
        type: 'update-local-items',
        updater: prevItems => {
          const nextItems = [...prevItems]
          nextItems[flow.index] = withPrayer
          return nextItems
        },
      })
      queuePrayedForSync(withPrayer)

      const nextIndex = flow.index + 1
      if (nextIndex >= localItems.length) {
        const completedAt = Date.now()
        recordPrayerCompletion(completedAt).catch(() => {})
        dispatchFlow({
          type: 'finish',
          prayedCount: completed + (alreadyPrayedToday ? 0 : 1),
        })
      } else {
        dispatchFlow({ type: 'set-active-index', index: nextIndex })
      }
    },
    [completed, flow, localItems, queuePrayedForSync, recordPrayedForLocalItem],
  )

  const handleBack = useCallback(
    () => {
      if (flow.type !== 'active') return

      if (flow.index === 0) {
        dispatchFlow({ type: 'show-overview' })
      } else {
        dispatchFlow({ type: 'set-active-index', index: flow.index - 1 })
      }
    },
    [flow],
  )

  const handleStepClick = useCallback(
    (index: number) => {
      dispatchFlow({ type: 'set-active-index', index })
    },
    [],
  )

  const handleItemClick = useCallback(
    (item: Item) => {
      const index = visibleIndexByItemId.get(item.id)
      if (index !== undefined) {
        handleStart(index)
      }
    },
    [handleStart, visibleIndexByItemId],
  )

  const handleCheck = useCallback(
    (item: Item) => recordPrayerFor(item, true),
    [recordPrayerFor],
  )

  const handleKeepPraying = useCallback(
    () => {
      const nextUnprayed: number[] = []
      const currentVisibleCount = visibleSchedule.length
      const currentSchedule = schedule

      for (let i = currentVisibleCount; i < currentSchedule.length; i++) {
        const item = currentSchedule[i]
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
      dispatchFlow({ type: 'set-local-items', items: expandedItems })
      dispatchFlow({ type: 'set-active-index', index: firstNewIndex })
    },
    [buildLocalItems, isPrayedForToday, schedule, showUntil, visibleSchedule.length],
  )

  const handleEditGoal = useCallback(() => openGoalDialog(), [openGoalDialog])
  const handleCloseGoalDialog = useCallback(() => closeGoalDialog(), [closeGoalDialog])
  const handleOpenEditDrawer = useCallback(() => setIsEditDrawerOpen(true), [])
  const activeFlowIndex = flow.type === 'active' ? flow.index : null
  const handleCloseEditDrawer = useCallback(
    () => {
      if (flow.type === 'active' && activeFlowIndex !== null) {
        const currentItem = localItems[activeFlowIndex]
        if (currentItem) {
          const existing = schedule.find(item => item.id === currentItem.id)
          const prayedForChanged = !!existing && JSON.stringify(existing.prayedFor) !== JSON.stringify(currentItem.prayedFor)

          if (prayedForChanged) {
            queuePrayedForSync(currentItem)
          } else {
            saveLocalItem(currentItem)
          }
        }
      }
      setIsEditDrawerOpen(false)
    },
    [activeFlowIndex, flow.type, localItems, queuePrayedForSync, saveLocalItem, schedule],
  )

  const handleGoToOverview = useCallback(() => {
    dispatchFlow({ type: 'show-overview' })
  }, [])
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

  const handleStartFirst = useCallback(
    () => {
      if (allVisiblePrayed && canKeepPraying) {
        handleKeepPraying()
      } else {
        handleStart(firstUnprayedIndex)
      }
    },
    [allVisiblePrayed, canKeepPraying, firstUnprayedIndex, handleKeepPraying, handleStart],
  )

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

  const actions = useMemo<PrayerFlowActions>(
    () => ({
      handleBack,
      handleChange,
      handleCheck,
      handleCloseEditDrawer,
      handleCloseGoalDialog,
      handleEditDrawerChange,
      handleEditGoal,
      handleGoToOverview,
      handleItemClick,
      handleKeepPraying,
      handleNext,
      handleOpenEditDrawer,
      handleStartFirst,
      handleStepClick,
    }),
    [
      handleBack,
      handleChange,
      handleCheck,
      handleCloseEditDrawer,
      handleCloseGoalDialog,
      handleEditDrawerChange,
      handleEditGoal,
      handleGoToOverview,
      handleItemClick,
      handleKeepPraying,
      handleNext,
      handleOpenEditDrawer,
      handleStartFirst,
      handleStepClick,
    ],
  )

  const state = useMemo<PrayerFlowStateView>(
    () => ({
      activeViewIndex,
      allVisiblePrayed,
      canKeepPraying,
      completed,
      firstUnprayedIndex,
      flow,
      goal,
      hideActiveView,
      isLastActiveStep,
      isPrayedForToday,
      localItems,
      naturalGoal,
      overlayFlow,
      shouldRenderActiveView,
      showActiveNavButtons,
      startButtonLabel,
      stepperActiveStep,
      stepperSteps,
      transitionDurationMs,
      viewTrackTransform,
      visibleSchedule,
    }),
    [
      activeViewIndex,
      allVisiblePrayed,
      canKeepPraying,
      completed,
      firstUnprayedIndex,
      flow,
      goal,
      hideActiveView,
      isLastActiveStep,
      isPrayedForToday,
      localItems,
      naturalGoal,
      overlayFlow,
      shouldRenderActiveView,
      showActiveNavButtons,
      startButtonLabel,
      stepperActiveStep,
      stepperSteps,
      transitionDurationMs,
      viewTrackTransform,
      visibleSchedule,
    ],
  )

  const ui = useMemo<PrayerFlowUi>(
    () => ({
      isEditDrawerOpen,
      isGoalDialogOpen,
    }),
    [isEditDrawerOpen, isGoalDialogOpen],
  )

  return {
    actions,
    state,
    ui,
  }
}