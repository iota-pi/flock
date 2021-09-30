import { Fragment, memo, MouseEvent, ReactNode, useCallback } from 'react';
import {
  Box,
  Checkbox,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
} from '@material-ui/core';
import { getItemName, Item } from '../state/items';
import TagDisplay from './TagDisplay';
import { getIcon } from './Icons';

const FADED_OPACITY = 0.65;

const StyledListItem = styled(ListItemButton)({
  minHeight: 72,
  '&.Mui-disabled': {
    opacity: '1 !important',
  },
});
const StyledListItemText = styled(ListItemText)(({ theme }) => ({
  flexGrow: 0,
  paddingRight: theme.spacing(2),
  transition: theme.transitions.create('opacity'),
}));
const StyledListItemIcon = styled(ListItemIcon)(({ theme }) => ({
  transition: theme.transitions.create('opacity'),
}));
const ListItemIconRight = styled(ListItemIcon)(({ theme }) => ({
  justifyContent: 'flex-end',
  minWidth: theme.spacing(5),
}));

export interface BaseProps<T extends Item> {
  actionIcon?: ReactNode,
  checkboxes?: boolean,
  checkboxSide?: 'left' | 'right',
  dividers?: boolean,
  linkTags?: boolean,
  maxTags?: number,
  onCheck?: (item: T) => void,
  onClick?: (item: T) => void,
  onClickAction?: (item: T) => void,
  showIcons?: boolean,
  showTags?: boolean,
}
export interface SingleItemProps<T extends Item> extends BaseProps<T> {
  checked?: boolean,
  description?: string,
  faded?: boolean,
  highlighted?: boolean,
  item: T,
}
export interface MultipleItemsProps<T extends Item> extends BaseProps<T> {
  className?: string,
  fadeArchived?: boolean,
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
}: SingleItemProps<T>) {
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

  const CheckboxHolder = checkboxSide === 'right' ? ListItemIconRight : ListItemIcon;
  const checkbox = checkboxes && onCheck && (
    <CheckboxHolder>
      <Checkbox
        data-cy="list-item-checkbox"
        edge={checkboxSide && (checkboxSide === 'left' ? 'start' : 'end')}
        checked={checked}
        tabIndex={-1}
        onClick={handleCheck}
        inputProps={{ 'aria-labelledby': `${item.id}-text` }}
      />
    </CheckboxHolder>
  );

  return (
    <Fragment key={item.id}>
      {dividers && <Divider />}

      <StyledListItem
        data-cy="list-item"
        disabled={!onClick && !onCheck && !onClickAction}
        selected={highlighted || false}
        onClick={onClick ? handleClick : undefined}
      >
        {checkboxSide !== 'right' && checkbox}

        {showIcons && (
          <StyledListItemIcon
            sx={{
              opacity: faded ? FADED_OPACITY : undefined,
            }}
          >
            {getIcon(item.type)}
          </StyledListItemIcon>
        )}

        <Box
          display="flex"
          flexDirection={{ xs: 'column', md: 'row' }}
          flexGrow={1}
        >
          <Box display="flex" flexDirection="column" justifyContent="center">
            <StyledListItemText
              id={`${item.id}-text`}
              primary={getItemName(item)}
              secondary={description || undefined}
              sx={{
                maxWidth: { xs: '60%', lg: '70%' },
                opacity: faded ? FADED_OPACITY : undefined,
              }}
            />
          </Box>

          <Box flexGrow={1} />

          {showTags && (
            <TagDisplay
              tags={item.tags}
              linked={linkTags}
              max={maxTags}
            />
          )}
        </Box>

        {actionIcon && (
          <Box ml={2}>
            <IconButton
              data-cy="list-item-action"
              disableRipple={!onClickAction}
              onClick={handleClickAction}
              size="large"
              sx={{
                '&:hover': !onClickAction ? {
                  backgroundColor: 'transparent',
                } : {},
              }}
            >
              {actionIcon}
            </IconButton>
          </Box>
        )}

        {checkboxSide === 'right' && checkbox}
      </StyledListItem>
    </Fragment>
  );
}
const MemoItemListItem = memo(ItemListItem) as typeof ItemListItem;


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
}: MultipleItemsProps<T>) {
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
        <MemoItemListItem
          actionIcon={actionIcon}
          checkboxes={checkboxes}
          checkboxSide={checkboxSide}
          checked={getChecked?.(item)}
          description={getClippedDescription(item)}
          faded={getFaded?.(item)}
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
