import React, { ReactNode, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Checkbox,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
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
  faded: {
    opacity: 0.65,
  },
}));

export interface BaseProps<T extends Item> {
  actionIcon?: ReactNode,
  className?: string,
  dividers?: boolean,
  items: T[],
  noItemsHint?: string,
  noItemsText?: string,
  onClick?: (item: T) => () => void,
  onClickAction?: (item: T) => () => void,
}

export interface PropsNoCheckboxes<T extends Item> extends BaseProps<T> {
  checkboxes?: false,
  getChecked?: undefined,
  onCheck?: undefined,
}
export interface PropsWithCheckboxes<T extends Item> extends BaseProps<T> {
  checkboxes: true,
  getChecked: (item: T) => boolean,
  onCheck: (item: T) => () => void,
}
export type Props<T extends Item> = PropsNoCheckboxes<T> | PropsWithCheckboxes<T>;


function ItemList<T extends Item>({
  actionIcon,
  checkboxes,
  className,
  dividers,
  getChecked,
  items,
  noItemsHint,
  noItemsText,
  onClick,
  onClickAction,
  onCheck,
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
            disabled={!onClick && !onCheck}
            onClick={onClick ? onClick(item) : undefined}
            classes={{
              disabled: classes.disabledOverride,
            }}
            className={classes.consistantMinHeight}
          >
            {checkboxes && getChecked && onCheck && (
              <ListItemIcon>
                <Checkbox
                  edge="start"
                  checked={getChecked(item)}
                  tabIndex={-1}
                  onClick={onCheck(item)}
                  inputProps={{ 'aria-labelledby': `${item.id}-text` }}
                />
              </ListItemIcon>
            )}
            <ListItemText
              primary={getItemName(item)}
              secondary={item.description}
              className={getChecked && getChecked(item) ? classes.faded : undefined}
              id={`${item.id}-text`}
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
