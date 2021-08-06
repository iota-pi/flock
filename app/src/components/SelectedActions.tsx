import React, { useCallback, useMemo, useState } from 'react';
import {
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  makeStyles,
  Typography,
} from '@material-ui/core';
import { useAppDispatch, useAppSelector } from '../store';
import {
  ArchiveIcon,
  DeleteIcon,
  InteractionIcon,
  MuiIconType,
  PrayerPointIcon,
  RemoveIcon,
  TagIcon,
  UnarchiveIcon,
} from './Icons';
import { useItems, useVault } from '../state/selectors';
import {
  deleteItems,
  getBlankInteraction,
  getBlankPrayerPoint,
  Item,
  lookupItemsById,
  updateItems,
} from '../state/items';
import { usePrevious } from '../utils';
import ConfirmationDialog from './dialogs/ConfirmationDialog';
import { setUiState, updateActive } from '../state/ui';
import TagDialog from './dialogs/TagDialog';

const useStyles = makeStyles(theme => ({
  root: {
    zIndex: theme.zIndex.drawer,
    backgroundColor: theme.palette.background.paper,
    transition: theme.transitions.create('all'),
  },
}));

export interface BulkAction {
  classes?: string[],
  dividerBefore?: boolean,
  icon: MuiIconType,
  id: string,
  label: string,
  onClick: () => void,
}

const PADDING_HEIGHT = 16;
const ACTION_HEIGHT = 48;

function SelectedActions() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const items = useItems();
  const selected = useAppSelector(state => state.ui.selected);
  const vault = useVault();

  const open = selected.length > 0;

  const selectedItems = useMemo(() => lookupItemsById(items, selected), [items, selected]);
  const prevSelectedItems = usePrevious(selectedItems) || [];

  const [showConfirm, setShowConfirm] = useState(false);
  const [showTags, setShowTags] = useState(false);

  const handleShowTags = useCallback(() => setShowTags(true), []);
  const handleHideTags = useCallback(() => setShowTags(false), []);
  const handleInteraction = useCallback(
    () => {
      dispatch(updateActive({
        initial: selectedItems.filter(item => item.type === 'person'),
        item: getBlankInteraction(),
      }));
    },
    [dispatch, selectedItems],
  );
  const handlePrayerPoint = useCallback(
    () => {
      dispatch(updateActive({
        initial: selectedItems,
        item: getBlankPrayerPoint(),
      }));
    },
    [dispatch, selectedItems],
  );
  const handleArchive = useCallback(
    (archived: boolean) => () => {
      const newItems: Item[] = selectedItems.map(item => ({ ...item, archived }));
      dispatch(updateItems(newItems));
    },
    [dispatch, selectedItems],
  );
  const handleInitialDelete = useCallback(() => setShowConfirm(true), []);
  const handleConfirmDelete = useCallback(
    () => {
      vault?.delete(selectedItems.map(item => item.id)).catch(error => console.error(error));
      dispatch(deleteItems(selectedItems));
      setShowConfirm(false);
    },
    [dispatch, selectedItems, vault],
  );
  const handleConfirmCancel = useCallback(() => setShowConfirm(false), []);
  const handleClear = useCallback(
    () => dispatch(setUiState({ selected: [] })),
    [dispatch],
  );

  const workingItems = open ? selectedItems : prevSelectedItems;
  const actions = useMemo<BulkAction[]>(
    () => {
      const result: BulkAction[] = [
        {
          id: 'tags',
          icon: TagIcon,
          label: 'Add/Remove Tags',
          onClick: handleShowTags,
        },
        {
          id: 'prayer-point',
          icon: PrayerPointIcon,
          label: 'Add Prayer Point',
          onClick: handlePrayerPoint,
        },
      ];
      if (workingItems.find(item => item.type === 'person')) {
        result.push({
          id: 'interaction',
          icon: InteractionIcon,
          label: 'Add Interaction',
          onClick: handleInteraction,
        });
      }
      if (workingItems.find(item => !item.archived)) {
        result.push({
          id: 'archive',
          icon: ArchiveIcon,
          label: 'Archive',
          onClick: handleArchive(true),
        });
      }
      if (workingItems.find(item => item.archived)) {
        result.push({
          id: 'unarchive',
          icon: UnarchiveIcon,
          label: 'Unarchive',
          onClick: handleArchive(false),
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
          label: 'Clear Selection',
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
      handlePrayerPoint,
      handleShowTags,
      workingItems,
    ],
  );

  const height = PADDING_HEIGHT + ACTION_HEIGHT * actions.length;

  return (
    <div
      className={classes.root}
      style={{ height: open ? height : 0 }}
    >
      <List>
        {actions.map(action => (
          <React.Fragment key={action.id}>
            {action.dividerBefore && <Divider />}

            <ListItem
              button
              className={action.classes?.join(' ')}
              onClick={action.onClick}
            >
              <ListItemIcon className={action.classes?.join(' ')}>
                <action.icon />
              </ListItemIcon>

              <ListItemText>
                {action.label}
              </ListItemText>
            </ListItem>
          </React.Fragment>
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
    </div>
  );
}

export default SelectedActions;
