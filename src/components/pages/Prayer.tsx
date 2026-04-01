/* eslint-disable react-hooks/set-state-in-effect */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Box, Button } from '@mui/material'
import { useLocation } from 'react-router'
import {
  cleanItem,
  DirtyItem,
  isItem,
  isValid,
  Item,
} from '../../state/items'
import { useItemMap } from '../../state/selectors'
import { usePrayerSchedule } from '../../hooks/usePrayerSchedule'
import { useToday } from '../../hooks/useToday'
import { mutateStoreItems } from '../../api/clientMutations'
import { recordPrayerCompletion } from '../../api/vault'
import { useDialogState } from '../../hooks/useDialogState'
import GoalDialog from '../dialogs/GoalDialog'
import BasePage from './BasePage'
import { isSameDay } from '../../utils'
import { getLastPrayedFor } from '../../utils/prayer'
import PrayerActiveView from './prayer/PrayerActiveView'
import PrayerFinishedView from './prayer/PrayerFinishedView'
import PrayerOverviewPanel from './prayer/PrayerOverviewPanel'
import PrayerStepper from './prayer/PrayerStepper'
import { BackIcon, NextIcon } from '../Icons'
import { createDebouncedByKey } from '../../utils/debounceByKey'


type FlowState =
  | { type: 'overview' }
  | { type: 'active'; index: number }
  | { type: 'finished'; prayedCount: number }


function PrayerPage() {
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
  const [isActiveViewPrepared, setIsActiveViewPrepared] = useState(false)
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

  // Reset to overview when the day rolls over, so stale active/finished
  // state isn't shown and the overview refreshes with the new day's schedule.
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

  // Warm active-view data asynchronously after overview render so the
  // overview appears immediately while active views are prepared in the background.
  useEffect(
    () => {
      if (flow.type !== 'overview') {
        return undefined
      }

      setIsActiveViewPrepared(false)
      let cancelled = false

      const prepare = () => {
        if (cancelled) {
          return
        }

        setLocalItems(buildLocalItems(visibleSchedule.length))
        setIsActiveViewPrepared(true)
      }

      const globalWindow = typeof window !== 'undefined' ? window : undefined
      if (globalWindow && 'requestIdleCallback' in globalWindow) {
        const idleId = globalWindow.requestIdleCallback(() => {
          prepare()
        }, { timeout: 250 })

        return () => {
          cancelled = true
          globalWindow.cancelIdleCallback?.(idleId)
        }
      }

      const timeoutId = globalThis.setTimeout(() => {
        prepare()
      }, 0)

      return () => {
        cancelled = true
        globalThis.clearTimeout(timeoutId)
      }
    },
    [flow.type, buildLocalItems, visibleSchedule.length],
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
      // Use pre-loaded items when available; rebuild as a fallback for the
      // rare case where the pre-load effect hasn't fired yet.
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

  return (
    <BasePage noScrollContainer>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
          <Box
            sx={{
              display: 'flex',
              height: '100%',
              transform: viewTrackTransform,
              transition: `transform ${transitionDurationMs}ms cubic-bezier(0.25, 0.8, 0.25, 1)`,
              width: '200%',
              willChange: 'transform',
            }}
          >
            <PrayerOverviewPanel
              completed={completed}
              goal={goal}
              naturalGoal={naturalGoal}
              visibleSchedule={visibleSchedule}
              isPrayedForToday={isPrayedForToday}
              onCheck={handleCheck}
              onEditGoal={handleEditGoal}
              onItemClick={handleItemClick}
              onStart={handleStartFirst}
              startDisabled={allVisiblePrayed && !canKeepPraying}
              startLabel={startButtonLabel}
            />

            <Box sx={{ bgcolor: 'background.default', position: 'relative', width: '50%' }}>
              {shouldRenderActiveView && (
                <Box
                  aria-hidden={hideActiveView}
                  sx={{
                    inset: 0,
                    pointerEvents: hideActiveView ? 'none' : 'auto',
                    position: 'absolute',
                    visibility: hideActiveView ? 'hidden' : 'visible',
                  }}
                >
                  <PrayerActiveView
                    activeIndex={activeViewIndex}
                    items={localItems}
                    isEditDrawerOpen={isEditDrawerOpen && flow.type === 'active'}
                    onBack={handleBack}
                    onCloseEditDrawer={handleCloseEditDrawer}
                    onEditDrawerChange={handleEditDrawerChange}
                    onItemChange={handleChange}
                    onNext={handleNext}
                    onOpenEditDrawer={handleOpenEditDrawer}
                  />
                </Box>
              )}
              {overlayFlow?.type === 'finished' && (
                <PrayerFinishedView
                  canKeepPraying={canKeepPraying}
                  onBackToOverview={() => setFlow({ type: 'overview' })}
                  onKeepPraying={handleKeepPraying}
                  prayedCount={overlayFlow.prayedCount}
                />
              )}
            </Box>
          </Box>
        </Box>

        <PrayerStepper
          activeStep={stepperActiveStep}
          isHomeActive={flow.type !== 'overview'}
          onHomeClick={handleGoToOverview}
          onStepClick={stepperSteps > 0 ? handleStepClick : undefined}
          steps={stepperSteps}
          backButton={showActiveNavButtons ? (
            <Button onClick={handleBack} startIcon={<BackIcon />}>
              Back
            </Button>
          ) : undefined}
          nextButton={showActiveNavButtons
            ? (
              <Button endIcon={<NextIcon />} onClick={handleNext}>
                {isLastActiveStep ? 'Finish' : 'Next'}
              </Button>
            )
            : (
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
        open={goalDialog.isOpen}
      />
    </BasePage>
  )
}

export default PrayerPage
