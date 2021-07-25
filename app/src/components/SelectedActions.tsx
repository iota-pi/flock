import React, { useCallback, useMemo } from 'react';
import { List, ListItem, ListItemIcon, ListItemText, makeStyles } from '@material-ui/core';
import { useAppDispatch, useAppSelector } from '../store';
import { ArchiveIcon, MuiIconType, UnarchiveIcon } from './Icons';
import { useItems } from '../state/selectors';
import { Item, lookupItemsById, updateItems } from '../state/items';

const useStyles = makeStyles(theme => ({
  root: {
    zIndex: theme.zIndex.drawer,
    backgroundColor: theme.palette.background.paper,
    transition: theme.transitions.create('all'),
  },
}));

export interface BulkAction {
  classes?: string[],
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

  const open = selected.length > 0;

  const selectedItems = useMemo(() => lookupItemsById(items, selected), [items, selected]);

  const handleArchive = useCallback(
    (archived: boolean) => () => {
      const newItems: Item[] = selectedItems.map(item => ({ ...item, archived }));
      dispatch(updateItems(newItems));
    },
    [dispatch, selectedItems],
  );

  const actions = useMemo<BulkAction[]>(
    () => {
      const result: BulkAction[] = [];
      if (selectedItems.find(item => !item.archived)) {
        result.push({
          id: 'archive',
          icon: ArchiveIcon,
          label: 'Archive',
          onClick: handleArchive(true),
        });
      }
      if (selectedItems.find(item => item.archived)) {
        result.push({
          id: 'unarchive',
          icon: UnarchiveIcon,
          label: 'Unarchive',
          onClick: handleArchive(false),
        });
      }
      return result;
    },
    [handleArchive, selectedItems],
  );

  const height = PADDING_HEIGHT + ACTION_HEIGHT * actions.length;

  return (
    <div
      className={classes.root}
      style={{ height: open ? height : 0 }}
    >
      <List>
        {actions.map(action => (
          <ListItem
            key={action.id}
            button
            onClick={action.onClick}
          >
            <ListItemIcon>
              <action.icon />
            </ListItemIcon>

            <ListItemText>
              {action.label}
            </ListItemText>
          </ListItem>
        ))}
      </List>
    </div>
  );
}

export default SelectedActions;
