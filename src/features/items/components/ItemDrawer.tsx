import {
  Suspense,
  useCallback,
  useMemo,
  useState,
} from 'react'
import { lazy } from 'src/utils/lazy'
import CircularProgress from '@mui/material/CircularProgress'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Typography from '@mui/material/Typography'

import {
  getItemName,
  getItemTypeLabel,
  isValid,
  type Item,
} from 'src/state/items'
import { useItem } from 'src/state/selectors'
import BaseDrawer, { type BaseDrawerProps } from 'src/components/drawers/BaseDrawer'
import ConfirmationDialog from 'src/components/dialogs/ConfirmationDialog'
import InlineText from 'src/components/ui/InlineText'
import {
  DeleteIcon,
  getIcon,
  getIconType,
} from 'src/components/Icons'
import { convertItemType, deleteItems, mutateItem } from '../mutations/itemMutations'
import ItemViewTopBar from './ItemViewTopBar'
import { ArchiveMenuItem, MarkPrayedMenuItem } from './ItemMenuItems'
import { ITEM_TYPES } from 'src/shared/schemas/items'
import type { ItemId } from '@vault/shared'
import type { ItemType } from 'src/shared/itemTypes'
import { useAppStore } from 'src/state/store'
import { createLogger } from '@vault/client'

const log = createLogger('ItemDrawer')


const ItemFormContent = lazy(() => import('./ItemFormContent'))


interface Props extends BaseDrawerProps {
  fromPrayerPage?: boolean,
  itemId: ItemId | null,
}


function ItemDrawer({
  alwaysTemporary,
  fromPrayerPage = false,
  itemId,
  onBack,
  onClose,
  open,
}: Props) {
  const resolvedItem = useItem(itemId ?? '' as ItemId) ?? null
  const setMessage = useAppStore(state => state.setMessage)
  const [showConfirmDelete, setShowConfirmDelete] = useState(false)
  const [hasEdited, setHasEdited] = useState(false)

  const [prevItemId, setPrevItemId] = useState(itemId)

  if (itemId !== prevItemId) {
    setPrevItemId(itemId)
    setHasEdited(false)
  }

  const handleChange = useCallback(
    (data: Partial<Item> | ((prev: Item) => Item)) => {
      if (!itemId || !resolvedItem) return

      setHasEdited(true)
      const changes = typeof data === 'function' ? data(resolvedItem) : data

      mutateItem(itemId, changes).catch(log.error)
    },
    [itemId, resolvedItem],
  )

  const isNew = resolvedItem?.isNew ?? false

  const cleanupAndClose = useCallback(
    () => {
      if (itemId !== null && isNew) {
        const latestItem = useAppStore.getState().items[itemId] as Item | undefined
        const itemToCheck = latestItem || resolvedItem
        // If the user edited the item, assume it's valid and don't delete it
        // even if a race condition temporarily makes it appear invalid.
        if (!hasEdited && itemToCheck && !isValid(itemToCheck)) {
          deleteItems(itemId).catch(log.error)
        }
      }

      onClose()
    },
    [hasEdited, itemId, isNew, resolvedItem, onClose],
  )

  const handleDelete = useCallback(
    () => {
      if (itemId !== null) {
        deleteItems(itemId).catch(log.error)
      }
      setShowConfirmDelete(false)
      onClose()
    },
    [itemId, onClose],
  )

  const handleConvertType = useCallback(
    async (targetType: ItemType) => {
      if (!itemId || !resolvedItem) return

      try {
        setHasEdited(true)
        await convertItemType(itemId, targetType)
      } catch (error) {
        setMessage({
          message: 'Failed to convert item type: ' + (error as Error).message,
          severity: 'error',
        })
      }
    },
    [itemId, resolvedItem, setMessage],
  )

  const changeTypeMenuItems = useMemo(
    () => ITEM_TYPES.filter(t => t !== resolvedItem?.type).map(itemType => (
      <MenuItem
        data-cy="change-type"
        key={itemType}
        onClick={() => {
          void handleConvertType(itemType)
        }}
      >
        <ListItemIcon>
          {getIcon(itemType)}
        </ListItemIcon>
        <ListItemText>Convert to {getItemTypeLabel(itemType)}</ListItemText>
      </MenuItem>
    )),
    [handleConvertType, resolvedItem?.type],
  )

  const deleteMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="delete"
        key="delete"
        disabled={isNew}
        onClick={() => {
          setShowConfirmDelete(true)
        }}
      >
        <ListItemIcon>
          <DeleteIcon />
        </ListItemIcon>
        <ListItemText>Delete</ListItemText>
      </MenuItem>
    ),
    [isNew],
  )

  const headerActions = useMemo(
    () => resolvedItem ? (
      <ItemViewTopBar
        compact
        item={resolvedItem}
        menuButtonDataCy="item-menu-button"
        menuItems={[
          <MarkPrayedMenuItem key="mark-prayed" item={resolvedItem} onChange={handleChange} />,
          ...(!fromPrayerPage ? changeTypeMenuItems : []),
          <ArchiveMenuItem key="archive" item={resolvedItem} onChange={handleChange} />,
          deleteMenuItem,
        ]}
        showEditButton={false}
      />
    ) : undefined,
    [changeTypeMenuItems, deleteMenuItem, fromPrayerPage, handleChange, resolvedItem],
  )

  return (
    <BaseDrawer
      ActionProps={{
        canSave: resolvedItem ? isValid(resolvedItem) : false,
        onSave: cleanupAndClose,
      }}
      alwaysTemporary={alwaysTemporary}
      headerActions={headerActions}
      itemKey={itemId ?? undefined}
      onBack={onBack}
      onClose={cleanupAndClose}
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

      {resolvedItem && (
        <ConfirmationDialog
          open={showConfirmDelete}
          onConfirm={handleDelete}
          onCancel={() => setShowConfirmDelete(false)}
        >
          <Typography>
            Are you sure you want to delete
            {' '}
            <InlineText>
              {getItemName(resolvedItem)}
            </InlineText>
            ?
          </Typography>

          <Typography>
            This action cannot be undone.
          </Typography>
        </ConfirmationDialog>
      )}
    </BaseDrawer>
  )
}

export default ItemDrawer
