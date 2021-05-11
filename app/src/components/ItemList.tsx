import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { IconButton, List, ListItem, ListItemSecondaryAction, ListItemText } from '@material-ui/core';
import ChevronRight from '@material-ui/icons/ChevronRight';
import { getItemName, Item } from '../state/items';

const useStyles = makeStyles(() => ({
  chevronButton: {
    '&:hover': {
      backgroundColor: 'transparent',
    },
  },
}));

export interface Props<T extends Item> {
  items: T[],
  onClick: (item: T) => () => void,
}


function ItemList<T extends Item>({
  items,
  onClick,
}: Props<T>) {
  const classes = useStyles();

  return (
    <List>
      {items.map(item => (
        <ListItem
          key={item.id}
          button
          onClick={onClick(item)}
        >
          <ListItemText primary={getItemName(item)} secondary={item.description} />
          <ListItemSecondaryAction>
            <IconButton
              className={classes.chevronButton}
              disableRipple
              onClick={onClick(item)}
            >
              <ChevronRight />
            </IconButton>
          </ListItemSecondaryAction>
        </ListItem>
      ))}

      {items.length === 0 && (
        <ListItem>
          <ListItemText primary="No items found" secondary="Click the plus button to add one!" />
        </ListItem>
      )}
    </List>
  );
}

export default ItemList;
