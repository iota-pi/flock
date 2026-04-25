import {
  useCallback,
  useMemo,
} from 'react'
import {
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
import ItemFormContent from './ItemFormContent'
import ItemViewTopBar from './ItemViewTopBar'
import { ITEM_TYPES } from 'src/shared/itemTypes'


interface Props extends BaseDrawerProps {
  fromPrayerPage?: boolean,
  item: LocalChangeItem<Item>,
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
  item,
  onBack,
  onChange,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const {
    item: automergeItem,
  } = useAutomergeItemDocument(item.id)
  const { applyItemUpdate } = useAutomergeItemCommands(item.id)

  const resolvedItem = useMemo(() => {
    if (item.isNew || !automergeItem) {
      return item
    }

    return {
      ...automergeItem,
      isNew: item.isNew,
    } as LocalChangeItem<Item>
  }, [automergeItem, item])

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
      deleteItem(item.id)
        .catch(error => console.error(error))
      onClose()
    },
    [item.id, onClose],
  )

  const { archived } = resolvedItem
  const lastPrayer = getLastPrayedFor(resolvedItem)
  const isPrayedForToday = isSameDay(new Date(), new Date(lastPrayer))

  const archiveMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="archive"
        key="archive"
        disabled={resolvedItem.isNew}
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
    [archived, handleChange, resolvedItem.isNew],
  )

  const changeTypeMenuItems = useMemo(
    () => ITEM_TYPES.filter(t => t !== resolvedItem.type).map(itemType => (
      <MenuItem
        data-cy="change-type"
        key={itemType}
        onClick={() => {
          handleChange(i => convertItem(i, itemType))
        }}
      >
        <ListItemIcon>
          {getIcon(itemType)}
        </ListItemIcon>
        <ListItemText>Convert to {getItemTypeLabel(itemType)}</ListItemText>
      </MenuItem>
    )),
    [resolvedItem.type, handleChange],
  )

  const markPrayedMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="mark-prayed"
        key="mark-prayed"
        disabled={resolvedItem.isNew}
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
    [handleChange, resolvedItem.isNew, isPrayedForToday],
  )

  const headerActions = useMemo(
    () => (
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
    ),
    [archiveMenuItem, changeTypeMenuItems, fromPrayerPage, markPrayedMenuItem, resolvedItem],
  )

  return (
    <BaseDrawer
      ActionProps={{
        canSave: isValid(resolvedItem),
        itemIsNew: resolvedItem.isNew,
        itemName: getItemName(resolvedItem),
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
        promptSave: false,
      }}
      alwaysTemporary={alwaysTemporary}
      headerActions={headerActions}
      itemKey={item.id}
      onBack={onBack}
      onClose={handleClose}
      onExited={onExited}
      open={open}
      stacked={stacked}
      typeIcon={getIconType(resolvedItem.type)}
    >
      <ItemFormContent
        key={resolvedItem.id}
        handleChange={handleChange}
        item={resolvedItem}
        fromPrayerPage={fromPrayerPage}
      />
    </BaseDrawer>
  )
}

export default ItemDrawer
