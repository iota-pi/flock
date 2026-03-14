import { TouchEvent, useMemo } from 'react'
import {
  Box,
  Button,
  Container,
  ListItemIcon,
  ListItemText,
  MenuItem,
  MobileStepper,
} from '@mui/material'
import {
  DirtyItem,
  Item,
} from '../../../state/items'
import ItemDrawer from '../../drawers/ItemDrawer'
import ItemFormContent from '../../drawers/ItemFormContent'
import ItemViewTopBar from '../../drawers/ItemViewTopBar'
import {
  ArchiveIcon,
  BackIcon,
  NextIcon,
  PrayerIcon,
  UnarchiveIcon,
} from '../../Icons'
import BasePage from '../BasePage'
import { isSameDay } from '../../../utils'
import { getLastPrayedFor } from '../../../utils/prayer'

interface Props {
  index: number,
  localItem: DirtyItem<Item>,
  totalSteps: number,
  isEditDrawerOpen: boolean,
  onBack: () => void,
  onNext: () => void,
  onOpenEditDrawer: () => void,
  onCloseEditDrawer: () => void,
  onEditDrawerChange: (
    data: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
  ) => void,
  onTouchStart: (e: TouchEvent) => void,
  onTouchEnd: (e: TouchEvent) => void,
  onItemChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => void,
}

function PrayerActiveView({
  index,
  localItem,
  totalSteps,
  isEditDrawerOpen,
  onBack,
  onNext,
  onOpenEditDrawer,
  onCloseEditDrawer,
  onEditDrawerChange,
  onTouchStart,
  onTouchEnd,
  onItemChange,
}: Props) {
  const isLast = index >= totalSteps - 1
  const activeItemArchived = localItem.archived
  const activeItemPrayedToday = isSameDay(new Date(), new Date(getLastPrayedFor(localItem)))

  const markPrayedMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="mark-prayed"
        key="mark-prayed"
        disabled={localItem.isNew}
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
    [activeItemPrayedToday, localItem.isNew, onItemChange],
  )

  const archiveMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="archive"
        key="archive"
        disabled={localItem.isNew}
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
    [activeItemArchived, localItem.isNew, onItemChange],
  )

  return (
    <BasePage noScrollContainer>
      <Box sx={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <ItemViewTopBar
          editButtonDataCy="active-item-edit-button"
          item={localItem}
          menuButtonDataCy="active-item-menu-button"
          menuItems={[
            markPrayedMenuItem,
            archiveMenuItem,
          ]}
          onEdit={onOpenEditDrawer}
        />

        <Box
          sx={{ flexGrow: 1, overflowY: 'auto' }}
          onTouchEnd={onTouchEnd}
          onTouchStart={onTouchStart}
        >
          <Container maxWidth={false} sx={{ py: 2 }}>
            <ItemFormContent
              autoFocusName={false}
              fromPrayerPage
              handleChange={onItemChange}
              hideHeaderFields
              hideRelationships
              item={localItem}
            />
          </Container>
        </Box>

        <MobileStepper
          activeStep={index}
          backButton={(
            <Button onClick={onBack} startIcon={<BackIcon />}>
              Back
            </Button>
          )}
          nextButton={(
            <Button endIcon={<NextIcon />} onClick={onNext}>
              {isLast ? 'Finish' : 'Next'}
            </Button>
          )}
          position="static"
          steps={totalSteps}
          variant="dots"
        />
      </Box>

      <ItemDrawer
        alwaysTemporary
        fromPrayerPage
        item={localItem}
        onBack={onCloseEditDrawer}
        onChange={onEditDrawerChange}
        onClose={onCloseEditDrawer}
        onExited={onCloseEditDrawer}
        open={isEditDrawerOpen}
        stacked={false}
      />
    </BasePage>
  )
}

export default PrayerActiveView
