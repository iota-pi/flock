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
  dirtyItem,
  DirtyItem,
  getItemName,
  getItemTypeLabel,
  isValid,
  Item,
  ITEM_TYPES,
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
import { mutateDeleteItems, mutateStoreItems } from '../mutations/itemMutations'
import { useAutomergeItem } from '../../../hooks/useAutomergeItem'
import ItemFormContent from './ItemFormContent'
import ItemViewTopBar from './ItemViewTopBar'
import useAutoSaveItem from '../hooks/useAutoSaveItem'


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
  const automergeItem = useAutomergeItem(item.id)

  const resolvedItem = useMemo(() => {
    if (item.dirty || item.isNew || !automergeItem) {
      return item
    }

    return {
      ...automergeItem,
      dirty: item.dirty,
      isNew: item.isNew,
    } as DirtyItem<Item>
  }, [automergeItem, item])

  const persistItem = useCallback(
    (cleanItemValue: Item) => {
      void mutateStoreItems(cleanItemValue).catch(error => {
        console.error(error)
      })
    },
    [],
  )

  const {
    disableAutoSaveNow,
    enableAutoSaveNow,
    saveItem,
  } = useAutoSaveItem({
    item,
    onPersist: persistItem,
    open,
  })

  const handleChange = useCallback(
    <T extends Item>(
      data: Partial<T> | ((prev: Item) => Item),
    ) => {
      enableAutoSaveNow()
      if (typeof data === 'function') {
        return onChange(originalItem => dirtyItem(data(originalItem)))
      }
      return onChange(dirtyItem(data))
    },
    [enableAutoSaveNow, onChange],
  )

  const handleSave = useCallback(
    (itemToSave: DirtyItem<Item>) => {
      return saveItem(itemToSave)
    },
    [saveItem],
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
      disableAutoSaveNow()
      onClose()
    },
    [disableAutoSaveNow, onClose],
  )
  const handleDelete = useCallback(
    () => {
      mutateDeleteItems(item.id)
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
        promptSave: !!resolvedItem.dirty,
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
        handleChange={handleChange}
        item={resolvedItem}
        fromPrayerPage={fromPrayerPage}
      />
    </BaseDrawer>
  )
}

export default ItemDrawer
