import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  ListItemIcon,
  ListItemText,
  MenuItem,
} from '@mui/material'
import {
  cleanItem,
  compareNames,
  convertItem,
  dirtyItem,
  DirtyItem,
  getItemName,
  getItemTypeLabel,
  GroupItem,
  isItem,
  isValid,
  Item,
  ITEM_TYPES,
} from '../../state/items'
import { useItems } from '../../state/selectors'
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer'
import { isSameDay, usePrevious } from '../../utils'
import {
  ArchiveIcon,
  getIcon,
  getIconType,
  PrayerIcon,
  UnarchiveIcon,
} from '../Icons'
import { getLastPrayedFor } from '../../utils/prayer'
import { useDeleteItemsMutation, useStoreItemsMutation } from '../../api/queries'
import ItemFormContent from './ItemFormContent'
import ItemViewTopBar from './ItemViewTopBar'


export interface Props extends BaseDrawerProps {
  fromPrayerPage?: boolean,
  item: DirtyItem<Item>,
  onChange: (
    item: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
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
  const groups = useItems<GroupItem>('group')
  const { mutateAsync: deleteItem } = useDeleteItemsMutation()
  const { mutate: storeItems } = useStoreItemsMutation()

  const [disableAutoSave, setDisableAutoSave] = useState(false)

  const prevItem = usePrevious(item)

  const memberGroups = useMemo(
    () => (
      item.type === 'person'
        ? groups.filter(g => g.members.includes(item.id)).sort(compareNames)
        : []
    ),
    [item.id, item.type, groups],
  )

  const handleChange = useCallback(
    <T extends Item>(
      data: Partial<T> | ((prev: Item) => Item),
    ) => {
      setDisableAutoSave(false)
      if (typeof data === 'function') {
        return onChange(originalItem => dirtyItem(data(originalItem)))
      }
      return onChange(dirtyItem(data))
    },
    [onChange],
  )

  const removeFromAllGroups = useCallback(
    () => {
      const updatedGroupItems: GroupItem[] = []
      for (const group of memberGroups) {
        const newGroup: GroupItem = {
          ...group,
          members: group.members.filter(m => m !== item.id),
        }
        updatedGroupItems.push(newGroup)
      }
      storeItems(updatedGroupItems)
    },
    [item.id, memberGroups, storeItems],
  )

  const handleSave = useCallback(
    (itemToSave: DirtyItem<Item>) => {
      if ((itemToSave.dirty || itemToSave.isNew) && isValid(itemToSave)) {
        setDisableAutoSave(true)
        const clean = cleanItem(itemToSave)
        if (isItem(clean)) {
          storeItems(clean)
        }
        return clean
      }
      return undefined
    },
    [storeItems],
  )
  const handleClose = useCallback(
    (disableSave?: boolean) => {
      if (!disableSave) {
        handleSave(item)
      }
      onClose()
    },
    [handleSave, item, onClose],
  )
  const handleSaveButton = useCallback(
    () => {
      const clean = handleSave(item)
      if (clean) {
        onChange(clean)
      }
    },
    [handleSave, item, onChange],
  )
  const handleCancel = useCallback(
    () => {
      setDisableAutoSave(true)
      onClose()
    },
    [onClose],
  )
  const handleDelete = useCallback(
    () => {
      removeFromAllGroups()
      deleteItem(item.id)
        .catch(error => console.error(error))
      onClose()
    },
    [deleteItem, item.id, onClose, removeFromAllGroups],
  )

  const handleUnmount = useCallback(
    () => {
      if (!disableAutoSave) {
        handleSave(item)
      }
    },
    [disableAutoSave, handleSave, item],
  )

  useEffect(
    () => {
      if (open && prevItem && prevItem.id !== item.id) {
        handleSave(prevItem)
      }
    },
    [handleSave, item.id, open, prevItem],
  )

  useEffect(
    () => {
      if (item.dirty && !item.isNew) {
        const timeout = setTimeout(
          () => handleSave(item),
          10000,
        )
        return () => clearTimeout(timeout)
      }
      return undefined
    },
    [handleSave, item],
  )

  const { archived } = item
  const lastPrayer = getLastPrayedFor(item)
  const isPrayedForToday = isSameDay(new Date(), new Date(lastPrayer))

  const archiveMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="archive"
        key="archive"
        disabled={item.isNew}
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
    [archived, handleChange, item.isNew],
  )

  const changeTypeMenuItems = useMemo(
    () => ITEM_TYPES.filter(t => t !== item.type).map(itemType => (
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
    [item.type, handleChange],
  )

  const markPrayedMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="mark-prayed"
        key="mark-prayed"
        disabled={item.isNew}
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
    [handleChange, item.isNew, isPrayedForToday],
  )

  const headerActions = useMemo(
    () => (
      <ItemViewTopBar
        compact
        item={item}
        menuButtonDataCy="item-menu-button"
        menuItems={[
          markPrayedMenuItem,
          archiveMenuItem,
          ...(!fromPrayerPage ? changeTypeMenuItems : []),
        ]}
        showEditButton={false}
      />
    ),
    [archiveMenuItem, changeTypeMenuItems, fromPrayerPage, item, markPrayedMenuItem],
  )

  return (
    <BaseDrawer
      ActionProps={{
        canSave: isValid(item),
        itemIsNew: item.isNew,
        itemName: getItemName(item),
        onCancel: handleCancel,
        onDelete: handleDelete,
        onSave: handleSaveButton,
        promptSave: !!item.dirty,
      }}
      alwaysTemporary={alwaysTemporary}
      headerActions={headerActions}
      itemKey={item.id}
      onBack={onBack}
      onClose={handleClose}
      onExited={onExited}
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
      typeIcon={getIconType(item.type)}
    >
      <ItemFormContent
        handleChange={handleChange}
        item={item}
        fromPrayerPage={fromPrayerPage}
      />
    </BaseDrawer>
  )
}

export default ItemDrawer
