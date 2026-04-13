import { Fragment, lazy, Suspense, useCallback, useMemo, useState } from 'react'
import {
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
  Typography,
} from '@mui/material'
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
import { ERROR_ITEM_TYPE, Item } from '../state/items'
import { usePrevious } from '../utils'
import { deleteItems, hardDeleteItems, storeItems } from '../features/items/mutations/itemMutations'
import { useNavigationStore } from '../state/navigationStore'

const ConfirmationDialog = lazy(() => import('./dialogs/ConfirmationDialog'))
const GroupDialog = lazy(() => import('./dialogs/GroupDialog'))
const FrequencyDialog = lazy(() => import('./dialogs/FrequencyDialog'))

const Root = styled('div')(({ theme }) => ({
  zIndex: theme.zIndex.drawer,
  backgroundColor: theme.palette.background.paper,
  transition: theme.transitions.create('all'),
}))
const ActionIconComponent = styled(ListItemIcon)(({ theme }) => ({
  minWidth: theme.spacing(5),
}))

interface BulkAction {
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
  const setSelected = useNavigationStore(state => state.setSelected)
  const getItemsById = useItemsById()
  const selected = useNavigationStore(state => state.selected)

  const selectedItems = useMemo(() => getItemsById(selected), [getItemsById, selected])
  const prevSelectedItems = usePrevious(selectedItems) || []
  const selectedStandardItems = useMemo(
    () => selectedItems.filter(item => item.type !== ERROR_ITEM_TYPE),
    [selectedItems],
  )
  const selectedErrorItems = useMemo(
    () => selectedItems.filter(item => item.type === ERROR_ITEM_TYPE),
    [selectedItems],
  )

  const [showConfirm, setShowConfirm] = useState(false)
  const [showGroup, setShowGroup] = useState(false)
  const [showFrequency, setShowFrequency] = useState(false)

  const handleShowGroup = useCallback(() => setShowGroup(true), [])
  const handleHideGroup = useCallback(() => setShowGroup(false), [])
  const handleShowFrequency = useCallback(() => setShowFrequency(true), [])
  const handleHideFrequency = useCallback(() => setShowFrequency(false), [])
  const handleSetArchived = useCallback(
    (archived: boolean) => {
      if (selectedStandardItems.length === 0) {
        return
      }

      const newItems: Item[] = selectedStandardItems.map(item => ({ ...item, archived }))
      void storeItems(newItems)
    },
    [selectedStandardItems],
  )
  const handleArchive = useCallback(() => handleSetArchived(true), [handleSetArchived])
  const handleUnarchive = useCallback(() => handleSetArchived(false), [handleSetArchived])
  const handleInitialDelete = useCallback(() => setShowConfirm(true), [])
  const handleConfirmDelete = useCallback(
    () => {
      const standardIds = selectedStandardItems.map(item => item.id)
      const errorIds = selectedErrorItems.map(item => item.id)

      const tasks: Promise<unknown>[] = []
      if (standardIds.length > 0) {
        tasks.push(deleteItems(standardIds))
      }
      if (errorIds.length > 0) {
        tasks.push(hardDeleteItems(errorIds))
      }

      void Promise.all(tasks).catch(error => console.error(error))
      setShowConfirm(false)
    },
    [selectedErrorItems, selectedStandardItems],
  )
  const handleConfirmCancel = useCallback(() => setShowConfirm(false), [])
  const handleClear = useCallback(
    () => setSelected([]),
    [setSelected],
  )

  const open = selectedItems.length > 0
  const workingItems = open ? selectedItems : prevSelectedItems
  const workingStandardItems = workingItems.filter(item => item.type !== ERROR_ITEM_TYPE)
  const hasWorkingErrorItems = workingItems.some(item => item.type === ERROR_ITEM_TYPE)

  const actions = useMemo<BulkAction[]>(
    () => {
      const result: BulkAction[] = []
      if (workingStandardItems.find(item => item.type === 'person')) {
        result.push({
          id: 'group',
          icon: GroupIcon,
          label: 'Add/Remove from Group',
          onClick: handleShowGroup,
        })
      }
      if (workingStandardItems.length > 0) {
        result.push({
          id: 'frequency',
          icon: FrequencyIcon,
          label: 'Set Prayer Frequency',
          onClick: handleShowFrequency,
        })

        if (workingStandardItems.find(item => !item.archived)) {
          result.push({
            id: 'archive',
            icon: ArchiveIcon,
            label: 'Archive',
            onClick: handleArchive,
          })
        }
        if (workingStandardItems.find(item => item.archived)) {
          result.push({
            id: 'unarchive',
            icon: UnarchiveIcon,
            label: 'Unarchive',
            onClick: handleUnarchive,
          })
        }
      }
      result.push(
        {
          id: 'delete',
          icon: DeleteIcon,
          label: hasWorkingErrorItems && workingStandardItems.length === 0 ? 'Hard Delete' : 'Delete',
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
      hasWorkingErrorItems,
      workingItems,
      workingStandardItems,
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

      <Suspense fallback={null}>
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
          items={selectedStandardItems}
          onClose={handleHideGroup}
          open={showGroup}
        />

        <FrequencyDialog
          items={selectedStandardItems}
          onClose={handleHideFrequency}
          open={showFrequency}
        />
      </Suspense>
    </Root>
  )
}

export default SelectedActions
