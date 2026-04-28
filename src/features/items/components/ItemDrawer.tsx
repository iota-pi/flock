import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
} from 'react'
import {
  CircularProgress,
  ListItemIcon,
  ListItemText,
  MenuItem,
} from '@mui/material'
import {
  convertItem,
  getItemName,
  getItemTypeLabel,
  isValid,
  Item,
  LocalChangeItem,
  StandardItem,
} from '../../../state/items'
import BaseDrawer, { BaseDrawerProps } from '../../../components/drawers/BaseDrawer'
import { isSameDay } from '../../../utils'
import {
  ArchiveIcon,
  getIcon,
  getIconType,
  PrayerIcon,
  UnarchiveIcon,
} from '../../../components/Icons'
import { getLastPrayedFor } from '../../../utils/prayer'
import { deleteItem } from '../mutations/itemMutations'
import { useAutomergeItemCommands, useAutomergeItemDocument } from 'src/sync/useAutomerge'
import ItemViewTopBar from './ItemViewTopBar'
import { ITEM_TYPES } from 'src/shared/itemTypes'

const ItemFormContent = lazy(() => import('./ItemFormContent'))


interface Props extends BaseDrawerProps {
  fromPrayerPage?: boolean,
  itemId: string,
  initialItem?: StandardItem,
  onChange: (
    item: Partial<Omit<Item, 'type' | 'id'>> | ((prev: Item) => Item),
  ) => void,
}

export interface ItemAndChangeCallback {
  item: Item,
  handleChange: <S extends Item>(data: Partial<Omit<S, 'type' | 'id'>>) => void,
}


function ItemDrawer({
  alwaysTemporary,
  fromPrayerPage = false,
  itemId,
  initialItem,
  onBack,
  onChange,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const {
    item: automergeItem,
  } = useAutomergeItemDocument(itemId)
  const { applyItemUpdate } = useAutomergeItemCommands(itemId)

  const resolvedItem = useMemo((): LocalChangeItem<Item> | null => {
    if (automergeItem) {
      return automergeItem as LocalChangeItem<Item>
    }
    if (initialItem) {
      return initialItem as LocalChangeItem<Item>
    }
    return null
  }, [automergeItem, initialItem])

  const handleChange = useCallback(
    (data: Partial<Item> | ((prev: Item) => Item)) => {
      applyItemUpdate(data)

      if (typeof data === 'function') {
        return onChange(data)
      }
      return onChange(data)
    },
    [applyItemUpdate, onChange],
  )

  const handleClose = useCallback(
    () => {
      onClose()
    },
    [onClose],
  )

  const handleSaveButton = useCallback(
    () => {
      onClose(true)
    },
    [onClose],
  )

  const handleCancel = useCallback(
    () => {
      onClose()
    },
    [onClose],
  )

  const handleDelete = useCallback(
    () => {
      deleteItem(itemId)
        .catch(error => console.error(error))
      onClose()
    },
    [itemId, onClose],
  )

  const archived = resolvedItem?.archived ?? false
  const lastPrayer = resolvedItem ? getLastPrayedFor(resolvedItem) : 0
  const isPrayedForToday = isSameDay(new Date(), new Date(lastPrayer))
  const isNew = (resolvedItem as LocalChangeItem<Item> & { isNew?: boolean } | null)?.isNew ?? false

  const archiveMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="archive"
        key="archive"
        disabled={isNew}
        onClick={() => {
          handleChange({ archived: !archived })
        }}
      >
        <ListItemIcon>
          {archived ? <UnarchiveIcon /> : <ArchiveIcon />}
        </ListItemIcon>
        <ListItemText>{archived ? 'Unarchive' : 'Archive'}</ListItemText>
      </MenuItem>
    ),
    [archived, handleChange, isNew],
  )

  const changeTypeMenuItems = useMemo(
    () => ITEM_TYPES.filter(t => t !== resolvedItem?.type).map(itemType => (
      <MenuItem
        data-cy="change-type"
        key={itemType}
        onClick={() => {
          if (resolvedItem) {
            handleChange(i => convertItem(i, itemType))
          }
        }}
      >
        <ListItemIcon>
          {getIcon(itemType)}
        </ListItemIcon>
        <ListItemText>Convert to {getItemTypeLabel(itemType)}</ListItemText>
      </MenuItem>
    )),
    [resolvedItem, handleChange],
  )

  const markPrayedMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="mark-prayed"
        key="mark-prayed"
        disabled={isNew}
        onClick={() => {
          handleChange(prev => {
            let prayedFor = prev.prayedFor
            if (isPrayedForToday) {
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
          {isPrayedForToday ? 'Unmark Prayed' : 'Mark as Prayed Today'}
        </ListItemText>
      </MenuItem>
    ),
    [handleChange, isNew, isPrayedForToday],
  )

  const headerActions = useMemo(
    () => resolvedItem ? (
      <ItemViewTopBar
        compact
        item={resolvedItem}
        menuButtonDataCy="item-menu-button"
        menuItems={[
          markPrayedMenuItem,
          archiveMenuItem,
          ...(!fromPrayerPage ? changeTypeMenuItems : []),
        ]}
        showEditButton={false}
      />
    ) : undefined,
    [archiveMenuItem, changeTypeMenuItems, fromPrayerPage, markPrayedMenuItem, resolvedItem],
  )

  return (
    <BaseDrawer
      ActionProps={{
        canSave: resolvedItem ? isValid(resolvedItem) : false,
        itemIsNew: isNew,
        itemName: resolvedItem ? getItemName(resolvedItem) : '',
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
        promptSave: false,
      }}
      alwaysTemporary={alwaysTemporary}
      headerActions={headerActions}
      itemKey={itemId}
      onBack={onBack}
      onClose={handleClose}
      onExited={onExited}
      open={open}
      stacked={stacked}
      typeIcon={resolvedItem ? getIconType(resolvedItem.type) : undefined}
    >
      <Suspense
        fallback={<CircularProgress size={24} sx={{ mt: 2 }} />}
      >
        {resolvedItem && (
          <ItemFormContent
            key={itemId}
            handleChange={handleChange}
            item={resolvedItem}
            fromPrayerPage={fromPrayerPage}
          />
        )}
      </Suspense>
    </BaseDrawer>
  )
}

export default ItemDrawer
