import { memo, useCallback, useMemo } from 'react'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'

import type { Item } from 'src/state/items'
import ItemFormContent from 'src/features/items/components/ItemFormContent'
import ItemViewTopBar from 'src/features/items/components/ItemViewTopBar'
import { ArchiveMenuItem, MarkPrayedMenuItem } from 'src/features/items/components/ItemMenuItems'
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
          <MarkPrayedMenuItem key="mark-prayed" item={activeItem} onChange={onItemChange} />,
          <ArchiveMenuItem key="archive" item={activeItem} onChange={onItemChange} />,
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
