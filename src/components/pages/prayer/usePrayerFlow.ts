/* eslint-disable react-hooks/set-state-in-effect */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation } from 'react-router'
import {
  cleanItem,
  DirtyItem,
  isItem,
  isValid,
  Item,
} from '../../../state/items'
import { useItemMap } from '../../../state/selectors'
import { usePrayerSchedule } from '../../../hooks/usePrayerSchedule'
import { useToday } from '../../../hooks/useToday'
import { mutateStoreItems } from '../../../features/items/mutations/itemMutations'
import { recordPrayerCompletion } from '../../../api/vault'
import { useDialogState } from '../../../hooks/useDialogState'
import { isSameDay } from '../../../utils'
import { getLastPrayedFor } from '../../../utils/prayer'
import { createDebouncedByKey } from '../../../utils/debounceByKey'
import usePrayerActiveViewPreload from './usePrayerActiveViewPreload'

export type FlowState =
  | { type: 'overview' }
  | { type: 'active'; index: number }
  | { type: 'finished'; prayedCount: number }

export type PrayerFlowController = {
  allVisiblePrayed: boolean
  canKeepPraying: boolean
  completed: number
  firstUnprayedIndex: number
  flow: FlowState
  goal: number
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
  hideActiveView: boolean
  isEditDrawerOpen: boolean
  isGoalDialogOpen: boolean
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

export default function usePrayerFlow(): PrayerFlowController {
  const location = useLocation()
  const itemMap = useItemMap()
  const storeItems = mutateStoreItems

  const today = useToday()
  const prevTodayRef = useRef(today)

  const [flow, setFlow] = useState<FlowState>({ type: 'overview' })
  const [localItems, setLocalItems] = useState<DirtyItem<Item>[]>([])
  const goalDialog = useDialogState('goal')
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false)
  const [lastOverlayFlow, setLastOverlayFlow] = useState<FlowState | null>(null)
  const prayedSyncQueue = useMemo(
    () => createDebouncedByKey<string, Item>(500, latestItem => {
      storeItems(latestItem)
    }),
    [storeItems],
  )

  useEffect(
    () => () => prayedSyncQueue.clear(),
    [prayedSyncQueue],
  )

  useEffect(
    () => {
      if (flow.type !== 'overview') {
        setLastOverlayFlow(flow)
      }
    },
    [flow],
  )

  const overlayFlow = flow.type !== 'overview' ? flow : lastOverlayFlow

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
        setFlow({ type: 'overview' })
        setIsEditDrawerOpen(false)
      }
    },
    [location.state],
  )

  useEffect(
    () => {
      if (today.getTime() !== prevTodayRef.current.getTime()) {
        prevTodayRef.current = today
        setFlow(prev => prev.type === 'overview' ? prev : { type: 'overview' })
        setLocalItems([])
        setIsEditDrawerOpen(false)
      }
    },
    [today],
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

  const isActiveViewPrepared = usePrayerActiveViewPreload({
    isOverview: flow.type === 'overview',
    visibleCount: visibleSchedule.length,
    buildLocalItems,
    setLocalItems,
  })

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

  const queuePrayedForSync = useCallback(
    (currentItem: DirtyItem<Item>) => {
      const clean = cleanItem(currentItem)
      if (!isItem(clean) || !isValid(clean)) {
        return
      }

      prayedSyncQueue.schedule(clean.id, clean)
    },
    [prayedSyncQueue],
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
      const items = localItems.length > 0 ? localItems : buildLocalItems(visibleSchedule.length)
      if (!items[fromIndex]) return
      if (items !== localItems) setLocalItems(items)
      setFlow({ type: 'active', index: fromIndex })
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
      setLocalItems(prevItems => {
        const nextItems = [...prevItems]
        nextItems[flow.index] = withPrayer
        return nextItems
      })
      queuePrayedForSync(withPrayer)

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
    [completed, flow, localItems, queuePrayedForSync, recordPrayedForLocalItem],
  )

  const handleBack = useCallback(
    () => {
      if (flow.type !== 'active') return

      if (flow.index === 0) {
        setFlow({ type: 'overview' })
      } else {
        setFlow({ type: 'active', index: flow.index - 1 })
      }
    },
    [flow],
  )

  const handleStepClick = useCallback(
    (index: number) => {
      setFlow({ type: 'active', index })
    },
    [],
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

  const handleEditGoal = useCallback(() => goalDialog.openDialog(), [goalDialog])
  const handleCloseGoalDialog = useCallback(() => goalDialog.closeDialog(), [goalDialog])
  const handleOpenEditDrawer = useCallback(() => setIsEditDrawerOpen(true), [])
  const handleCloseEditDrawer = useCallback(
    () => {
      if (flow.type === 'active') {
        const currentItem = localItems[flow.index]
        if (currentItem) {
          const existing = itemMap[currentItem.id]
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
    [flow, itemMap, localItems, queuePrayedForSync, saveLocalItem],
  )

  const handleGoToOverview = useCallback(() => setFlow({ type: 'overview' }), [])
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

  return {
    activeViewIndex,
    allVisiblePrayed,
    canKeepPraying,
    completed,
    firstUnprayedIndex,
    flow,
    goal,
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
    hideActiveView,
    isEditDrawerOpen,
    isGoalDialogOpen: goalDialog.isOpen,
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
  }
}