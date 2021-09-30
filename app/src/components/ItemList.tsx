import { Fragment, MouseEvent, ReactNode, useCallback } from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  Box,
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

    [theme.breakpoints.down('md')]: {
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

    [theme.breakpoints.down('sm')]: {
      flexDirection: 'column',
    },
  },
}));

export interface BaseProps<T extends Item> {
  actionIcon?: ReactNode,
  checkboxes?: boolean,
  checkboxSide?: 'left' | 'right',
  dividers?: boolean,
  fadeArchived?: boolean,
  linkTags?: boolean,
  maxTags?: number,
  onCheck?: (item: T) => void,
  onClick?: (item: T) => void,
  onClickAction?: (item: T) => void,
  showIcons?: boolean,
  showTags?: boolean,
}

export interface PropsNoCheckboxes<T extends Item> extends BaseProps<T> {
  checkboxes?: false,
  checkboxSide?: undefined,
  getChecked?: undefined,
  onCheck?: undefined,
}
export type Props<T extends Item> = BaseProps<T> | PropsNoCheckboxes<T>;
export interface SingleItemProps<T extends Item> {
  checked?: boolean,
  description?: string,
  faded?: boolean,
  highlighted?: boolean,
  item: T,
}
export interface MultipleItemsProps<T extends Item> {
  className?: string,
  getChecked?: (item: T) => boolean,
  getDescription?: (item: T) => string,
  getForceFade?: (item: T) => boolean,
  getHighlighted?: (item: T) => boolean,
  items: T[],
  noItemsHint?: string,
  noItemsText?: string,
}

export function ItemListItem<T extends Item>({
  actionIcon,
  checkboxes,
  checkboxSide,
  checked,
  description,
  dividers,
  faded,
  highlighted,
  item,
  linkTags = true,
  maxTags,
  onClick,
  onClickAction,
  onCheck,
  showIcons = false,
  showTags = true,
}: Props<T> & SingleItemProps<T>) {
  const classes = useStyles();

  const handleClick = useCallback(
    () => onClick?.(item),
    [item, onClick],
  );
  const handleClickAction = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      if (onClickAction) {
        return onClickAction(item);
      } else if (onClick) {
        return onClick(item);
      }
      return undefined;
    },
    [item, onClick, onClickAction],
  );
  const handleCheck = useCallback(
    (event: MouseEvent) => {
      if (onCheck) {
        event.stopPropagation();
        onCheck(item);
      }
    },
    [item, onCheck],
  );

  const checkbox = checkboxes && onCheck && (
    <ListItemIcon
      className={checkboxSide === 'right' ? classes.rightCheckbox : undefined}
    >
      <Checkbox
        data-cy="list-item-checkbox"
        edge={checkboxSide && (checkboxSide === 'left' ? 'start' : 'end')}
        checked={checked}
        tabIndex={-1}
        onClick={handleCheck}
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
        selected={highlighted || false}
        onClick={onClick ? handleClick : undefined}
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
              faded ? classes.faded : undefined,
            ].join(' ')}
          >
            {getIcon(item.type)}
          </ListItemIcon>
        )}

        <div className={classes.listItemMainContent}>
          <Box display="flex" flexDirection="column" justifyContent="center">
            <ListItemText
              className={([
                classes.itemText,
                classes.couldFade,
                item.tags.length > 0 ? classes.itemTextWithTags : undefined,
                faded ? classes.faded : undefined,
              ].join(' '))}
              id={`${item.id}-text`}
              primary={getItemName(item)}
              secondary={description || undefined}
            />
          </Box>

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
              onClick={handleClickAction}
              size="large"
            >
              {actionIcon}
            </IconButton>
          </div>
        )}

        {checkboxSide === 'right' && checkbox}
      </ListItem>
    </Fragment>
  );
}


function ItemList<T extends Item>({
  actionIcon,
  checkboxes,
  checkboxSide,
  className,
  dividers,
  fadeArchived = true,
  getChecked,
  getDescription,
  getForceFade,
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
}: Props<T> & MultipleItemsProps<T>) {
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

  const getFaded = useCallback(
    (item: T) => {
      if (item.archived && fadeArchived) {
        return true;
      }
      if (getForceFade && getForceFade(item)) {
        return true;
      }
      return false;
    },
    [fadeArchived, getForceFade],
  );

  return (
    <List className={className}>
      {dividers && items.length === 0 && <Divider />}

      {items.map(item => (
        <ItemListItem
          actionIcon={actionIcon}
          checkboxes={checkboxes}
          checkboxSide={checkboxSide}
          checked={getChecked?.(item)}
          description={getClippedDescription(item)}
          faded={getFaded?.(item)}
          fadeArchived={fadeArchived}
          highlighted={getHighlighted?.(item)}
          item={item}
          key={item.id}
          linkTags={linkTags}
          maxTags={maxTags}
          onClick={onClick}
          onClickAction={onClickAction}
          onCheck={onCheck}
          showIcons={showIcons}
          showTags={showTags}
        />
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
