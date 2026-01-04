import { Fragment, useCallback, useMemo, useState } from 'react'
import {
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
  Typography,
} from '@mui/material'
import { useAppDispatch, useAppSelector } from '../store'
import {
  ArchiveIcon,
  DeleteIcon,
  FrequencyIcon,
  GroupIcon,
  MuiIconType,
  RemoveIcon,
  UnarchiveIcon,
} from './Icons'
import { useItemsById } from '../state/selectors'
import { Item } from '../state/items'
import { usePrevious } from '../utils'
import ConfirmationDialog from './dialogs/ConfirmationDialog'
import { setUi } from '../state/ui'
import GroupDialog from './dialogs/GroupDialog'
import FrequencyDialog from './dialogs/FrequencyDialog'
import { useDeleteItemsMutation, useStoreItemsMutation } from '../api/queries'

const Root = styled('div')(({ theme }) => ({
  zIndex: theme.zIndex.drawer,
  backgroundColor: theme.palette.background.paper,
  transition: theme.transitions.create('all'),
}))
const ActionIconComponent = styled(ListItemIcon)(({ theme }) => ({
  minWidth: theme.spacing(5),
}))

export interface BulkAction {
  classes?: string[],
  dividerBefore?: boolean,
  icon: MuiIconType,
  id: string,
  label: string,
  onClick: () => void,
}

const PADDING_HEIGHT = 2
const ACTION_HEIGHT = 36.02

function SelectedActions() {
  const dispatch = useAppDispatch()
  const getItemsById = useItemsById()
  const selected = useAppSelector(state => state.ui.selected)
  const { mutateAsync: deleteItems } = useDeleteItemsMutation()
  const { mutateAsync: storeItems } = useStoreItemsMutation()

  const selectedItems = useMemo(() => getItemsById(selected), [getItemsById, selected])
  const prevSelectedItems = usePrevious(selectedItems) || []

  const [showConfirm, setShowConfirm] = useState(false)
  const [showGroup, setShowGroup] = useState(false)
  const [showFrequency, setShowFrequency] = useState(false)

  const handleShowGroup = useCallback(() => setShowGroup(true), [])
  const handleHideGroup = useCallback(() => setShowGroup(false), [])
  const handleShowFrequency = useCallback(() => setShowFrequency(true), [])
  const handleHideFrequency = useCallback(() => setShowFrequency(false), [])
  const handleSetArchived = useCallback(
    (archived: boolean) => {
      const newItems: Item[] = selectedItems.map(item => ({ ...item, archived }))
      storeItems(newItems)
    },
    [selectedItems, storeItems],
  )
  const handleArchive = useCallback(() => handleSetArchived(true), [handleSetArchived])
  const handleUnarchive = useCallback(() => handleSetArchived(false), [handleSetArchived])
  const handleInitialDelete = useCallback(() => setShowConfirm(true), [])
  const handleConfirmDelete = useCallback(
    () => {
      const ids = selectedItems.map(item => item.id)
      deleteItems(ids)
        .catch(error => console.error(error))
      setShowConfirm(false)
    },
    [deleteItems, selectedItems],
  )
  const handleConfirmCancel = useCallback(() => setShowConfirm(false), [])
  const handleClear = useCallback(
    () => dispatch(setUi({ selected: [] })),
    [dispatch],
  )

  const open = selectedItems.length > 0
  const workingItems = open ? selectedItems : prevSelectedItems

  const actions = useMemo<BulkAction[]>(
    () => {
      const result: BulkAction[] = []
      if (workingItems.find(item => item.type === 'person')) {
        result.push({
          id: 'group',
          icon: GroupIcon,
          label: 'Add/Remove from Group',
          onClick: handleShowGroup,
        })
      }
      result.push({
        id: 'frequency',
        icon: FrequencyIcon,
        label: 'Set Prayer Frequency',
        onClick: handleShowFrequency,
      })
      if (workingItems.find(item => !item.archived)) {
        result.push({
          id: 'archive',
          icon: ArchiveIcon,
          label: 'Archive',
          onClick: handleArchive,
        })
      }
      if (workingItems.find(item => item.archived)) {
        result.push({
          id: 'unarchive',
          icon: UnarchiveIcon,
          label: 'Unarchive',
          onClick: handleUnarchive,
        })
      }
      result.push(
        {
          id: 'delete',
          icon: DeleteIcon,
          label: 'Delete',
          onClick: handleInitialDelete,
        },
        {
          dividerBefore: true,
          id: 'clear',
          icon: RemoveIcon,
          label: `Clear Selection (${workingItems.length} items)`,
          onClick: handleClear,
        },
      )
      return result
    },
    [
      handleArchive,
      handleClear,
      handleInitialDelete,
      handleShowFrequency,
      handleShowGroup,
      handleUnarchive,
      workingItems,
    ],
  )

  const height = Math.ceil(PADDING_HEIGHT + ACTION_HEIGHT * actions.length)

  return (
    <Root style={{ height: open ? height : 0 }}>
      <Divider />

      <List disablePadding>
        {actions.map(action => (
          <Fragment key={action.id}>
            {action.dividerBefore && <Divider />}

            <ListItemButton
              className={action.classes?.join(' ')}
              onClick={action.onClick}
              data-cy={`action-${action.id}`}
              dense
            >
              <ActionIconComponent
                className={(action.classes || []).join(' ')}
              >
                <action.icon />
              </ActionIconComponent>

              <ListItemText>
                {action.label}
              </ListItemText>
            </ListItemButton>
          </Fragment>
        ))}
      </List>

      <ConfirmationDialog
        confirmColour="error"
        open={showConfirm}
        onCancel={handleConfirmCancel}
        onConfirm={handleConfirmDelete}
      >
        <Typography>
          Are you sure you want to delete {selected.length} items?
        </Typography>

        <Typography>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>

      <GroupDialog
        items={selectedItems}
        onClose={handleHideGroup}
        open={showGroup}
      />

      <FrequencyDialog
        items={selectedItems}
        onClose={handleHideFrequency}
        open={showFrequency}
      />
    </Root>
  )
}

export default SelectedActions
