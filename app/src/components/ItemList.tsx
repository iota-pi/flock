import React, { ReactNode } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Divider, IconButton, List, ListItem, ListItemSecondaryAction, ListItemText } from '@material-ui/core';
import ChevronRight from '@material-ui/icons/ChevronRight';
import { getItemName, Item } from '../state/items';

const useStyles = makeStyles(() => ({
  noHover: {
    '&:hover': {
      backgroundColor: 'transparent',
    },
  },
  consistantMinHeight: {
    minHeight: 72,
  },
}));

export interface Props<T extends Item> {
  actionIcon?: ReactNode,
  className?: string,
  dividers?: boolean,
  items: T[],
  noItemsHint?: string,
  noItemsText?: string,
  onClick: (item: T) => () => void,
  onClickAction?: (item: T) => () => void,
}


function ItemList<T extends Item>({
  actionIcon,
  className,
  dividers,
  items,
  noItemsHint,
  noItemsText,
  onClick,
  onClickAction,
}: Props<T>) {
  const classes = useStyles();

  return (
    <List className={className}>
      {items.map(item => (
        <React.Fragment key={item.id}>
          {dividers && <Divider />}

          <ListItem
            button
            onClick={onClick(item)}
            className={classes.consistantMinHeight}
          >
            <ListItemText
              primary={getItemName(item)}
              secondary={item.description}
            />
            <ListItemSecondaryAction>
              <IconButton
                className={!onClickAction ? classes.noHover : undefined}
                disableRipple={!onClickAction}
                onClick={onClickAction ? onClickAction(item) : onClick(item)}
              >
                {actionIcon || <ChevronRight />}
              </IconButton>
            </ListItemSecondaryAction>
          </ListItem>
        </React.Fragment>
      ))}

      {items.length === 0 && (
        <ListItem>
          <ListItemText primary={noItemsText} secondary={noItemsHint} />
        </ListItem>
      )}

      {dividers && <Divider />}
    </List>
  );
}

export default ItemList;
