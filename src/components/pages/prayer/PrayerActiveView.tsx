import { memo, useCallback, useMemo } from 'react'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'

import { Item } from 'src/state/items'
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
import { useAppStore } from 'src/state/store'


interface Props {
  activeIndex: number,
  items: Item[],
  onBack: () => void,
  onNext: () => void,
  onItemChange: (data: Partial<Item> | ((prev: Item) => Item)) => void,
}

function PrayerActiveView({
  activeIndex,
  items,
  onBack,
  onNext,
  onItemChange,
}: Props) {
  const setDrawer = useAppStore(state => state.setDrawer)
  const activeItem = items[activeIndex]

  const activeItemArchived = activeItem.archived
  const activeItemPrayedToday = isSameDay(new Date(), new Date(getLastPrayedFor(activeItem)))

  const handleOpenEditDrawer = useCallback(
    () => {
      setDrawer({
        item: activeItem.id,
        fromPrayerPage: true,
        alwaysTemporary: true,
        disableRouting: true,
        open: true,
      })
    },
    [activeItem.id, setDrawer],
  )

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
        onEdit={handleOpenEditDrawer}
      />

      <SwipeableCarousel activeIndex={activeIndex} onBack={onBack} onNext={onNext}>
        {formSlides}
      </SwipeableCarousel>
    </Box>
  )
}

export default memo(PrayerActiveView)
