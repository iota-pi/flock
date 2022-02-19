import { Fragment, useCallback, useMemo, useState } from 'react';
import { Divider, List, ListItem, ListItemIcon, ListItemText, Typography } from '@mui/material';
import makeStyles from '@mui/styles/makeStyles';
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
import { useItemsById, useVault } from '../state/selectors';
import {
  getBlankInteraction,
  getBlankPrayerPoint,
  Item,
} from '../state/items';
import { usePrevious } from '../utils';
import ConfirmationDialog from './dialogs/ConfirmationDialog';
import { setUiState, replaceActive } from '../state/ui';
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
  const getItemsById = useItemsById();
  const selected = useAppSelector(state => state.ui.selected);
  const vault = useVault();

  const open = selected.length > 0;

  const selectedItems = useMemo(() => getItemsById(selected), [getItemsById, selected]);
  const prevSelectedItems = usePrevious(selectedItems) || [];

  const [showConfirm, setShowConfirm] = useState(false);
  const [showTags, setShowTags] = useState(false);

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
  const handlePrayerPoint = useCallback(
    () => {
      dispatch(replaceActive({
        initial: selectedItems,
        newItem: getBlankPrayerPoint(),
      }));
    },
    [dispatch, selectedItems],
  );
  const handleSetArchived = useCallback(
    (archived: boolean) => {
      const newItems: Item[] = selectedItems.map(item => ({ ...item, archived }));
      vault?.store(newItems);
    },
    [selectedItems, vault],
  );
  const handleArchive = useCallback(() => handleSetArchived(true), [handleSetArchived]);
  const handleUnarchive = useCallback(() => handleSetArchived(false), [handleSetArchived]);
  const handleInitialDelete = useCallback(() => setShowConfirm(true), []);
  const handleConfirmDelete = useCallback(
    () => {
      vault?.delete(selectedItems.map(item => item.id)).catch(error => console.error(error));
      setShowConfirm(false);
    },
    [selectedItems, vault],
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
      handlePrayerPoint,
      handleShowTags,
      handleUnarchive,
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
          <Fragment key={action.id}>
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
    </div>
  );
}

export default SelectedActions;
