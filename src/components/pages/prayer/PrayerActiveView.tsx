import { memo, useEffect, useMemo } from 'react'
import {
  Box,
  Container,
  ListItemIcon,
  ListItemText,
  MenuItem,
} from '@mui/material'
import {
  Item,
  LocalChangeItem,
} from 'src/state/items'
import { DrawerData, useNavigationStore } from 'src/state/navigationStore'
import ItemFormContent from 'src/features/items/components/ItemFormContent'
import ItemViewTopBar from 'src/features/items/components/ItemViewTopBar'
import {
  ArchiveIcon,
  PrayerIcon,
  UnarchiveIcon,
} from '../../Icons'
import { isSameDay } from 'src/utils'
import { getLastPrayedFor } from 'src/utils/prayer'
import SwipeableCarousel from '../../ui/SwipeableCarousel'

interface Props {
  activeIndex: number,
  items: LocalChangeItem<Item>[],
  isEditDrawerOpen: boolean,
  onBack: () => void,
  onNext: () => void,
  onOpenEditDrawer: () => void,
  onCloseEditDrawer: () => void,
  onEditDrawerChange: (
    data: Partial<Omit<Item, 'type' | 'id'>> | ((prev: Item) => Item),
  ) => void,
  onItemChange: (data: Partial<Item> | ((prev: Item) => Item)) => void,
}

function PrayerActiveView({
  activeIndex,
  items,
  isEditDrawerOpen,
  onBack,
  onNext,
  onOpenEditDrawer,
  onCloseEditDrawer,
  onEditDrawerChange,
  onItemChange,
}: Props) {
  const setDrawer = useNavigationStore(state => state.setDrawer)

  const activeItem = items[activeIndex]

  const activeDrawer = useNavigationStore(state => state.activeDrawer)
  const activePrayerDrawer = (
    activeDrawer
    && activeDrawer.fromPrayerPage === true
    && activeDrawer.disableRouting === true
    && typeof activeDrawer.item !== 'string'
    && !!activeDrawer.onChange
  )
    ? activeDrawer
    : undefined

  useEffect(
    () => {
      if (!isEditDrawerOpen && !activePrayerDrawer) {
        return
      }

      const nextPrayerDrawerPayload: Partial<Omit<DrawerData, 'id'>> = {
        alwaysTemporary: true,
        disableRouting: true,
        fromPrayerPage: true,
        item: activeItem.id,
        onChange: onEditDrawerChange,
        onCloseRequest: onCloseEditDrawer,
        open: isEditDrawerOpen,
      }

      const requiresSync = (
        !activePrayerDrawer
        || activePrayerDrawer.item !== nextPrayerDrawerPayload.item
        || activePrayerDrawer.onChange !== nextPrayerDrawerPayload.onChange
        || activePrayerDrawer.onCloseRequest !== nextPrayerDrawerPayload.onCloseRequest
        || activePrayerDrawer.open !== nextPrayerDrawerPayload.open
      )

      if (!requiresSync) {
        return
      }

      setDrawer(nextPrayerDrawerPayload)
    },
    [
      activeItem.id,
      isEditDrawerOpen,
      onCloseEditDrawer,
      onEditDrawerChange,
      setDrawer,
      activePrayerDrawer,
    ],
  )

  const activeItemArchived = activeItem.archived
  const activeItemPrayedToday = isSameDay(new Date(), new Date(getLastPrayedFor(activeItem)))

  const markPrayedMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="mark-prayed"
        key="mark-prayed"
        disabled={activeItem.isNew}
        onClick={() => {
          onItemChange((prev: Item) => {
            let prayedFor = prev.prayedFor
            if (activeItemPrayedToday) {
              const startOfDay = new Date()
              startOfDay.setHours(0, 0, 0, 0)
              prayedFor = prayedFor.filter(d => d < startOfDay.getTime())
            } else {
              prayedFor = [...prayedFor, new Date().getTime()]
            }
            return { ...prev, prayedFor }
          })
        }}
      >
        <ListItemIcon>
          <PrayerIcon />
        </ListItemIcon>
        <ListItemText>
          {activeItemPrayedToday ? 'Unmark Prayed' : 'Mark as Prayed Today'}
        </ListItemText>
      </MenuItem>
    ),
    [activeItem.isNew, activeItemPrayedToday, onItemChange],
  )

  const archiveMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="archive"
        key="archive"
        disabled={activeItem.isNew}
        onClick={() => {
          onItemChange({ archived: !activeItemArchived })
        }}
      >
        <ListItemIcon>
          {activeItemArchived ? <UnarchiveIcon /> : <ArchiveIcon />}
        </ListItemIcon>
        <ListItemText>{activeItemArchived ? 'Unarchive' : 'Archive'}</ListItemText>
      </MenuItem>
    ),
    [activeItem.isNew, activeItemArchived, onItemChange],
  )

  const formSlides = useMemo(
    () => items.map((item, itemIndex) => (
      <Box key={item.id} sx={{ flexShrink: 0, height: '100%', overflowY: 'auto', width: '100%' }}>
        {Math.abs(itemIndex - activeIndex) <= 1
          ? (
            <Container maxWidth={false} sx={{ py: 2 }}>
              <ItemFormContent
                autoFocusName={false}
                fromPrayerPage
                key={item.id}
                handleChange={
                  itemIndex === activeIndex
                    ? onItemChange
                    : (() => undefined)
                }
                hideHeaderFields
                hideRelationships
                item={item}
              />
            </Container>
          )
          : <Box sx={{ height: '100%', width: '100%' }} />}
      </Box>
    )),
    [activeIndex, items, onItemChange],
  )

  return (
    <Box sx={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <ItemViewTopBar
        editButtonDataCy="active-item-edit-button"
        item={activeItem}
        menuButtonDataCy="active-item-menu-button"
        menuItems={[
          markPrayedMenuItem,
          archiveMenuItem,
        ]}
        onEdit={onOpenEditDrawer}
      />

      <SwipeableCarousel activeIndex={activeIndex} onBack={onBack} onNext={onNext}>
        {formSlides}
      </SwipeableCarousel>
    </Box>
  )
}

export default memo(PrayerActiveView)
