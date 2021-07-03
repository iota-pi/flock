import React, { MouseEvent, ReactNode, useCallback } from 'react';
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
import TagDisplay from './TagDisplay';

const useStyles = makeStyles(theme => ({
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
  itemText: {
    flexGrow: 0,
    paddingRight: theme.spacing(2),
  },
  itemTextWithTags: {
    maxWidth: '70%',

    [theme.breakpoints.down('sm')]: {
      maxWidth: '60%',
    },
  },
  spacer: {
    flexGrow: 1,
  },
}));

export interface BaseProps<T extends Item> {
  actionIcon?: ReactNode,
  className?: string,
  dividers?: boolean,
  getDescription?: (item: T) => string,
  items: T[],
  noItemsHint?: string,
  noItemsText?: string,
  onClick?: (item: T) => () => void,
  onClickAction?: (item: T) => () => void,
  showTags?: boolean,
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
  getDescription,
  items,
  noItemsHint,
  noItemsText,
  onClick,
  onClickAction,
  onCheck,
  showTags = true,
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

  const handleCheck = useCallback(
    (item: T) => (event: MouseEvent) => {
      if (onCheck) {
        event.stopPropagation();
        onCheck(item)();
      }
    },
    [onCheck],
  );

  const getClippedDescription = useCallback(
    (item: T) => {
      const base = getDescription ? getDescription(item) : item.description;
      const clipped = base.slice(0, 100);
      if (clipped.length < base.length) {
        const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '));
        return `${clippedToWord}…`;
      }
      return base;
    },
    [getDescription],
  );

  return (
    <List className={className}>
      {dividers && items.length === 0 && <Divider />}

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
                  onClick={handleCheck(item)}
                  inputProps={{ 'aria-labelledby': `${item.id}-text` }}
                />
              </ListItemIcon>
            )}

            <ListItemText
              primary={getItemName(item)}
              secondary={getClippedDescription(item)}
              className={([
                classes.itemText,
                item.tags.length > 0 ? classes.itemTextWithTags : undefined,
                getChecked && getChecked(item) ? classes.faded : undefined,
              ].join(' '))}
              id={`${item.id}-text`}
            />

            {showTags && (
              <div>
                <TagDisplay tags={item.tags} />
              </div>
            )}

            <div className={classes.spacer} />

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
