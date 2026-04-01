import { memo, useCallback, useMemo } from 'react'
import {
  Box,
  Container,
  ListItemIcon,
  ListItemText,
  MenuItem,
} from '@mui/material'
import { useSwipeable } from 'react-swipeable'
import {
  DirtyItem,
  Item,
} from '../../../state/items'
import ItemDrawer from '../../../features/items/components/ItemDrawer'
import ItemFormContent from '../../../features/items/components/ItemFormContent'
import ItemViewTopBar from '../../../features/items/components/ItemViewTopBar'
import {
  ArchiveIcon,
  PrayerIcon,
  UnarchiveIcon,
} from '../../Icons'
import { isSameDay } from '../../../utils'
import { getLastPrayedFor } from '../../../utils/prayer'

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
  const activeItem = items[activeIndex]
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

  const handleSwiped = useCallback(
    ({ deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return
      if (deltaX < 0) {
        onNext()
      } else {
        onBack()
      }
    },
    [onBack, onNext],
  )

  const swipeHandlers = useSwipeable({
    delta: 60,
    onSwiped: handleSwiped,
    preventScrollOnSwipe: false,
    trackMouse: false,
    trackTouch: true,
  })

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
    <>
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

        <Box {...swipeHandlers} sx={{ flexGrow: 1, overflow: 'hidden', width: '100%' }}>
          <Box
            sx={{
              display: 'flex',
              height: '100%',
              transform: `translateX(-${activeIndex * 100}%)`,
              transition: 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
              width: '100%',
            }}
          >
            {formSlides}
          </Box>
        </Box>

      </Box>

      <ItemDrawer
        alwaysTemporary
        fromPrayerPage
        item={activeItem}
        onBack={onCloseEditDrawer}
        onChange={onEditDrawerChange}
        onClose={onCloseEditDrawer}
        onExited={onCloseEditDrawer}
        open={isEditDrawerOpen}
        stacked={false}
      />
    </>
  )
}

export default memo(PrayerActiveView)
