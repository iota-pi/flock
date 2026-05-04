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
  StandardItem,
} from '../../../state/items'
import { useDataStore } from '../../../state/dataStore'
import { SyncBridge } from '../../../sync/SyncBridge'
import { useItem } from '../../../state/selectors'
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
import ItemViewTopBar from './ItemViewTopBar'
import { ITEM_TYPES } from 'src/shared/itemTypes'

const ItemFormContent = lazy(() => import('./ItemFormContent'))


interface Props extends BaseDrawerProps {
  fromPrayerPage?: boolean,
  itemId: string | null,
  initialItem?: StandardItem,
  onChange: (
    item: Partial<Omit<Item, 'type' | 'id'>> | ((prev: Item) => Item),
  ) => void,
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
}: Props) {
  const storeItem = useItem(itemId ?? '')

  const resolvedItem = useMemo((): Item | null => {
    if (storeItem) {
      return storeItem
    }
    if (initialItem) {
      return initialItem
    }
    return null
  }, [storeItem, initialItem])

  const handleChange = useCallback(
    (data: Partial<Item> | ((prev: Item) => Item)) => {
      if (!itemId || !resolvedItem) return
      
      const changes = typeof data === 'function' ? data(resolvedItem) : data
      
      useDataStore.getState().optimisticUpdateItem(itemId, changes)
      
      const mutationId = crypto.randomUUID()
      SyncBridge.mutateItem(mutationId, itemId, changes).catch(error => console.error(error))

      if (typeof data === 'function') {
        return onChange(data)
      }
      return onChange(data)
    },
    [itemId, resolvedItem, onChange],
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
      if (itemId !== null) {
        deleteItem(itemId).catch(error => console.error(error))
      }
      onClose()
    },
    [itemId, onClose],
  )

  const archived = resolvedItem?.archived ?? false
  const lastPrayer = resolvedItem ? getLastPrayedFor(resolvedItem) : 0
  const isPrayedForToday = isSameDay(new Date(), new Date(lastPrayer))
  const isNew = (resolvedItem as Item & { isNew?: boolean } | null)?.isNew ?? false

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
      itemKey={itemId ?? undefined}
      onBack={onBack}
      onClose={handleClose}
      onExited={onExited}
      open={open}
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
