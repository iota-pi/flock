import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  styled,
  Typography,
} from '@mui/material';
import { useAppDispatch, useAppSelector } from '../store';
import {
  ActionIcon,
  ArchiveIcon,
  DeleteIcon,
  GroupIcon,
  InteractionIcon,
  MuiIconType,
  RemoveIcon,
  TagIcon,
  UnarchiveIcon,
} from './Icons';
import { useItemsById } from '../state/selectors';
import {
  getBlankAction,
  getBlankInteraction,
  Item,
} from '../state/items';
import { usePrevious } from '../utils';
import ConfirmationDialog from './dialogs/ConfirmationDialog';
import { setUiState, replaceActive } from '../state/ui';
import TagDialog from './dialogs/TagDialog';
import GroupDialog from './dialogs/GroupDialog';
import { deleteItems, storeItems } from '../api/Vault';

const Root = styled('div')(({ theme }) => ({
  zIndex: theme.zIndex.drawer,
  backgroundColor: theme.palette.background.paper,
  transition: theme.transitions.create('all'),
}));
const ActionIconComponent = styled(ListItemIcon)(({ theme }) => ({
  minWidth: theme.spacing(5),
}));

export interface BulkAction {
  classes?: string[],
  dividerBefore?: boolean,
  icon: MuiIconType,
  id: string,
  label: string,
  onClick: () => void,
}

const PADDING_HEIGHT = 2;
const ACTION_HEIGHT = 36.02;

function SelectedActions() {
  const dispatch = useAppDispatch();
  const getItemsById = useItemsById();
  const selected = useAppSelector(state => state.ui.selected);

  const open = selected.length > 0;

  const selectedItems = useMemo(() => getItemsById(selected), [getItemsById, selected]);
  const prevSelectedItems = usePrevious(selectedItems) || [];

  const [showConfirm, setShowConfirm] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [showTags, setShowTags] = useState(false);

  const handleShowGroup = useCallback(() => setShowGroup(true), []);
  const handleHideGroup = useCallback(() => setShowGroup(false), []);
  const handleShowTags = useCallback(() => setShowTags(true), []);
  const handleHideTags = useCallback(() => setShowTags(false), []);
  const handleInteraction = useCallback(
    () => {
      dispatch(replaceActive({
        initial: selectedItems.filter(item => item.type === 'person'),
        newItem: getBlankInteraction(),
      }));
    },
    [dispatch, selectedItems],
  );
  const handleAction = useCallback(
    () => {
      dispatch(replaceActive({
        initial: selectedItems,
        newItem: getBlankAction(),
      }));
    },
    [dispatch, selectedItems],
  );
  const handleSetArchived = useCallback(
    (archived: boolean) => {
      const newItems: Item[] = selectedItems.map(item => ({ ...item, archived }));
      storeItems(newItems);
    },
    [selectedItems],
  );
  const handleArchive = useCallback(() => handleSetArchived(true), [handleSetArchived]);
  const handleUnarchive = useCallback(() => handleSetArchived(false), [handleSetArchived]);
  const handleInitialDelete = useCallback(() => setShowConfirm(true), []);
  const handleConfirmDelete = useCallback(
    () => {
      deleteItems(selectedItems.map(item => item.id)).catch(error => console.error(error));
      setShowConfirm(false);
    },
    [selectedItems],
  );
  const handleConfirmCancel = useCallback(() => setShowConfirm(false), []);
  const handleClear = useCallback(
    () => dispatch(setUiState({ selected: [] })),
    [dispatch],
  );

  const workingItems = open ? selectedItems : prevSelectedItems;
  const actions = useMemo<BulkAction[]>(
    () => {
      const result: BulkAction[] = [];
      if (workingItems.find(item => item.type === 'person')) {
        result.push({
          id: 'group',
          icon: GroupIcon,
          label: 'Add/Remove from Group',
          onClick: handleShowGroup,
        });
      }
      result.push(
        {
          id: 'tags',
          icon: TagIcon,
          label: 'Add/Remove Tags',
          onClick: handleShowTags,
        },
      );
      if (workingItems.find(item => item.type === 'person')) {
        result.push({
          id: 'interaction',
          icon: InteractionIcon,
          label: 'New Interaction',
          onClick: handleInteraction,
        });
      }
      result.push({
        id: 'action',
        icon: ActionIcon,
        label: 'New Action Item',
        onClick: handleAction,
      });
      if (workingItems.find(item => !item.archived)) {
        result.push({
          id: 'archive',
          icon: ArchiveIcon,
          label: 'Archive',
          onClick: handleArchive,
        });
      }
      if (workingItems.find(item => item.archived)) {
        result.push({
          id: 'unarchive',
          icon: UnarchiveIcon,
          label: 'Unarchive',
          onClick: handleUnarchive,
        });
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
      );
      return result;
    },
    [
      handleArchive,
      handleClear,
      handleInitialDelete,
      handleInteraction,
      handleAction,
      handleShowGroup,
      handleShowTags,
      handleUnarchive,
      workingItems,
    ],
  );

  const height = Math.ceil(PADDING_HEIGHT + ACTION_HEIGHT * actions.length);

  return (
    <Root style={{ height: open ? height : 0 }}>
      <Divider />

      <List disablePadding>
        {actions.map(action => (
          <Fragment key={action.id}>
            {action.dividerBefore && <Divider />}

            <ListItem
              button
              className={action.classes?.join(' ')}
              onClick={action.onClick}
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
            </ListItem>
          </Fragment>
        ))}
      </List>

      <ConfirmationDialog
        open={showConfirm}
        onCancel={handleConfirmCancel}
        onConfirm={handleConfirmDelete}
      >
        <Typography paragraph>
          Are you sure you want to delete {selected.length} items?
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>

      <TagDialog
        items={selectedItems}
        onClose={handleHideTags}
        open={showTags}
      />

      <GroupDialog
        items={selectedItems}
        onClose={handleHideGroup}
        open={showGroup}
      />
    </Root>
  );
}

export default SelectedActions;
