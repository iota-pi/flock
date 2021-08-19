import { Fragment, MouseEvent, ReactNode, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Checkbox,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from '@material-ui/core';
import { getItemName, Item } from '../state/items';
import TagDisplay from './TagDisplay';
import { getIcon } from './Icons';

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
  couldFade: {
    transition: theme.transitions.create('opacity'),
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
  rightCheckbox: {
    justifyContent: 'flex-end',
    minWidth: theme.spacing(5),
  },
  spacer: {
    flexGrow: 1,
  },
  actionButton: {
    marginLeft: theme.spacing(2),
  },
  listItemMainContent: {
    display: 'flex',
    flexDirection: 'row',
    flexGrow: 1,

    [theme.breakpoints.down('xs')]: {
      flexDirection: 'column',
    },
  },
}));

export interface BaseProps<T extends Item> {
  actionIcon?: ReactNode,
  checkboxSide?: 'left' | 'right',
  className?: string,
  dividers?: boolean,
  fadeArchived?: boolean,
  getChecked?: (item: T) => boolean,
  getDescription?: (item: T) => string,
  getFaded?: (item: T) => boolean,
  getHighlighted?: (item: T) => boolean,
  items: T[],
  linkTags?: boolean,
  maxTags?: number,
  noItemsHint?: string,
  noItemsText?: string,
  onCheck?: (item: T) => () => void,
  onClick?: (item: T) => () => void,
  onClickAction?: (item: T) => void,
  showIcons?: boolean,
  showTags?: boolean,
}

export interface PropsNoCheckboxes<T extends Item> extends BaseProps<T> {
  checkboxes?: false,
}
export interface PropsWithCheckboxes<T extends Item> extends BaseProps<T> {
  checkboxes: true,
  checkboxSide?: 'left' | 'right',
  getChecked: Exclude<BaseProps<T>['getChecked'], undefined>,
  onCheck: Exclude<BaseProps<T>['onCheck'], undefined>,
}
export type Props<T extends Item> = PropsNoCheckboxes<T> | PropsWithCheckboxes<T>;


function ItemList<T extends Item>({
  actionIcon,
  checkboxes,
  checkboxSide,
  className,
  dividers,
  fadeArchived = true,
  getChecked,
  getDescription,
  getFaded,
  getHighlighted,
  items,
  linkTags = true,
  maxTags,
  noItemsHint,
  noItemsText,
  onClick,
  onClickAction,
  onCheck,
  showIcons = false,
  showTags = true,
}: Props<T>) {
  const classes = useStyles();

  const handleClickAction = useCallback(
    (item: T) => (event: MouseEvent) => {
      event.stopPropagation();
      if (onClickAction) {
        return onClickAction(item);
      } else if (onClick) {
        return onClick(item)();
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

  const getItemFaded = useCallback(
    (item: T) => {
      if (item.archived && fadeArchived) {
        return true;
      }
      if (getFaded && getFaded(item)) {
        return true;
      }
      return false;
    },
    [fadeArchived, getFaded],
  );

  return (
    <List className={className}>
      {dividers && items.length === 0 && <Divider />}

      {items.map(item => {
        const checkbox = checkboxes && getChecked && onCheck && (
          <ListItemIcon
            className={checkboxSide === 'right' ? classes.rightCheckbox : undefined}
          >
            <Checkbox
              data-cy="list-item-checkbox"
              edge={checkboxSide && (checkboxSide === 'left' ? 'start' : 'end')}
              checked={getChecked(item)}
              tabIndex={-1}
              onClick={handleCheck(item)}
              inputProps={{ 'aria-labelledby': `${item.id}-text` }}
            />
          </ListItemIcon>
        );

        return (
          <Fragment key={item.id}>
            {dividers && <Divider />}

            <ListItem
              button
              data-cy="list-item"
              disabled={!onClick && !onCheck && !onClickAction}
              selected={getHighlighted ? getHighlighted(item) : false}
              onClick={onClick ? onClick(item) : undefined}
              classes={{
                disabled: classes.disabledOverride,
              }}
              className={classes.consistantMinHeight}
            >
              {checkboxSide !== 'right' && checkbox}

              {showIcons && (
                <ListItemIcon
                  className={[
                    classes.couldFade,
                    getItemFaded(item) ? classes.faded : undefined,
                  ].join(' ')}
                >
                  {getIcon(item.type)}
                </ListItemIcon>
              )}

              <div className={classes.listItemMainContent}>
                <ListItemText
                  primary={getItemName(item)}
                  secondary={getClippedDescription(item)}
                  className={([
                    classes.itemText,
                    classes.couldFade,
                    item.tags.length > 0 ? classes.itemTextWithTags : undefined,
                    getItemFaded(item) ? classes.faded : undefined,
                  ].join(' '))}
                  id={`${item.id}-text`}
                />

                <div className={classes.spacer} />

                {showTags && (
                  <TagDisplay
                    tags={item.tags}
                    linked={linkTags}
                    max={maxTags}
                  />
                )}
              </div>

              {actionIcon && (
                <div className={classes.actionButton}>
                  <IconButton
                    className={!onClickAction ? classes.noHover : undefined}
                    data-cy="list-item-action"
                    disableRipple={!onClickAction}
                    onClick={handleClickAction(item)}
                  >
                    {actionIcon}
                  </IconButton>
                </div>
              )}

              {checkboxSide === 'right' && checkbox}
            </ListItem>
          </Fragment>
        );
      })}

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
