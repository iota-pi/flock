import { memo, useEffect, useMemo } from 'react'
import {
  Box,
  Container,
  ListItemIcon,
  ListItemText,
  MenuItem,
} from '@mui/material'
import {
  DirtyItem,
  Item,
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
  items: DirtyItem<Item>[],
  isEditDrawerOpen: boolean,
  onBack: () => void,
  onNext: () => void,
  onOpenEditDrawer: () => void,
  onCloseEditDrawer: () => void,
  onEditDrawerChange: (
    data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
  ) => void,
  onItemChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => void,
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
  const drawers = useNavigationStore(state => state.drawers)
  const pushActive = useNavigationStore(state => state.pushActive)
  const replaceActive = useNavigationStore(state => state.replaceActive)

  const activeItem = items[activeIndex]

  const topDrawer = drawers[drawers.length - 1]
  const topPrayerDrawer = (
    topDrawer
    && topDrawer.fromPrayerPage === true
    && topDrawer.disableRouting === true
    && typeof topDrawer.item !== 'string'
    && !!topDrawer.onChange
  )
    ? topDrawer
    : undefined

  useEffect(
    () => {
      if (!isEditDrawerOpen && !topPrayerDrawer) {
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
        stacked: false,
      }

      const requiresSync = (
        !topPrayerDrawer
        || topPrayerDrawer.item !== nextPrayerDrawerPayload.item
        || topPrayerDrawer.onChange !== nextPrayerDrawerPayload.onChange
        || topPrayerDrawer.onCloseRequest !== nextPrayerDrawerPayload.onCloseRequest
        || topPrayerDrawer.open !== nextPrayerDrawerPayload.open
      )

      if (!requiresSync) {
        return
      }

      if (topPrayerDrawer) {
        replaceActive(nextPrayerDrawerPayload)
      } else {
        pushActive(nextPrayerDrawerPayload)
      }
    },
    [
      activeItem.id,
      isEditDrawerOpen,
      onCloseEditDrawer,
      onEditDrawerChange,
      pushActive,
      replaceActive,
      topPrayerDrawer,
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
