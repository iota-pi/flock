import React, { ReactNode, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemSecondaryAction,
  ListItemText,
} from '@material-ui/core';
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
  disabledOverride: {
    opacity: '1 !important',
  },
}));

export interface Props<T extends Item> {
  actionIcon?: ReactNode,
  className?: string,
  dividers?: boolean,
  items: T[],
  noItemsHint?: string,
  noItemsText?: string,
  onClick?: (item: T) => () => void,
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

  const handleClickAction = useCallback(
    (item: T) => {
      if (onClickAction) {
        return onClickAction(item);
      } else if (onClick) {
        return onClick(item);
      }
      return undefined;
    },
    [onClick, onClickAction],
  );

  return (
    <List className={className}>
      {items.map(item => (
        <React.Fragment key={item.id}>
          {dividers && <Divider />}

          <ListItem
            button
            disabled={!onClick}
            onClick={onClick ? onClick(item) : undefined}
            classes={{
              disabled: classes.disabledOverride,
            }}
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
                onClick={handleClickAction(item)}
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
