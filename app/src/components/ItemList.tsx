import {
  memo,
  MouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  Box,
  Breakpoint,
  Checkbox,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemIconProps,
  ListItemText,
  ListItemTextProps,
  styled,
  SxProps,
  Theme,
  useMediaQuery,
} from '@mui/material';
import {
  ListChildComponentProps,
  ListItemKeySelector,
  VariableSizeList,
} from 'react-window';
import { getItemName, isItem, Item } from '../state/items';
import TagDisplay from './TagDisplay';
import { getIcon as getItemIcon } from './Icons';
import { MostlyRequired, usePrevious, useStringMemo } from '../utils';

const FADED_OPACITY = 0.65;
const TAG_ROW_BREAKPOINT: Breakpoint = 'md';
const MIN_ROW_HEIGHT = 72;

const StyledListItem = styled(ListItemButton)(
  ({ dense }) => ({
    minHeight: !dense ? MIN_ROW_HEIGHT : undefined,
    '&.Mui-disabled': {
      opacity: '1 !important',
    },
  }),
);
const StyledListItemText = styled(
  ListItemText,
  {
    shouldForwardProp: prop => prop !== 'faded' && prop !== 'wrapText',
  },
)<ListItemTextProps & { faded?: boolean, wrapText: boolean }>(
  ({ faded, theme, wrapText }) => ({
    opacity: faded ? FADED_OPACITY : undefined,
    paddingRight: theme.spacing(2),
    transition: theme.transitions.create('opacity'),
    whiteSpace: !wrapText ? 'nowrap' : undefined,

    '& .MuiTypography-root': {
      textOverflow: !wrapText ? 'ellipsis' : undefined,
      overflow: !wrapText ? 'hidden' : undefined,
    },
  }),
);
const StyledListItemIcon = styled(
  ({ faded: _, ...props }: ListItemIconProps & { faded?: boolean }) => <ListItemIcon {...props} />,
)(({ faded, theme }) => ({
  opacity: faded ? FADED_OPACITY : undefined,
  transition: theme.transitions.create('opacity'),
}));
const ListItemIconRight = styled(ListItemIcon)(({ theme }) => ({
  justifyContent: 'flex-end',
  minWidth: theme.spacing(5),
}));

export interface ItemListExtraElement {
  content: ReactNode,
  height: number,
  index: number,
}
export interface BaseProps<T extends Item> {
  checkboxes?: boolean,
  checkboxSide?: 'left' | 'right',
  compact?: boolean,
  dividers?: boolean,
  extraElements?: ItemListExtraElement[],
  fadeArchived?: boolean,
  getActionIcon?: (item: T) => ReactNode,
  getChecked?: (item: T) => boolean,
  getDescription?: (item: T) => string,
  getForceFade?: (item: T) => boolean,
  getHighlighted?: (item: T) => boolean,
  getIcon?: (item: T) => ReactNode,
  getTitle?: (item: T) => string,
  items: T[],
  linkTags?: boolean,
  maxTags?: number,
  onCheck?: (item: T) => void,
  onClick?: (item: T) => void,
  onClickAction?: (item: T) => void,
  showIcons?: boolean,
  showTags?: boolean,
  wrapText?: boolean,
}
export interface MultipleItemsProps<T extends Item> extends BaseProps<T> {
  className?: string,
  disablePadding?: boolean,
  noItemsHint?: string,
  noItemsText?: string,
  paddingBottom?: number,
  viewHeight?: number,
}

export function ItemListItem<T extends Item>(props: ListChildComponentProps<BaseProps<T>>) {
  const { data, index, style } = props;
  const {
    checkboxes,
    checkboxSide,
    compact,
    dividers,
    extraElements,
    fadeArchived,
    getActionIcon,
    getChecked,
    getDescription,
    getForceFade,
    getHighlighted,
    getIcon,
    getTitle,
    items,
    linkTags = true,
    maxTags,
    onClick,
    onClickAction,
    onCheck,
    showIcons = false,
    showTags = true,
    wrapText = false,
  } = data;
  const item = items[index];

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

  const actionIcon = useMemo(
    () => getActionIcon?.(item),
    [getActionIcon, item],
  );
  const checked = useMemo(() => getChecked?.(item), [getChecked, item]);
  const icon = useMemo(
    () => getIcon?.(item) || (isItem(item) ? getItemIcon(item.type) : undefined),
    [getIcon, item],
  );
  const title = useMemo(
    () => getTitle?.(item) || (isItem(item) ? getItemName(item) : undefined),
    [getTitle, item],
  );
  const description = useMemo(
    () => {
      const defaultDescription = isItem(item) ? item.description : '';
      const base = getDescription ? getDescription(item) : defaultDescription;
      const clipped = base.slice(0, 100);
      if (clipped.length < base.length) {
        const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '));
        return `${clippedToWord}…`;
      }
      return base;
    },
    [getDescription, item],
  );
  const faded = useMemo(
    () => {
      if (isItem(item) && item.archived && fadeArchived) {
        return true;
      }
      if (getForceFade && getForceFade(item)) {
        return true;
      }
      return false;
    },
    [fadeArchived, getForceFade, item],
  );
  const highlighted = useMemo(() => getHighlighted?.(item), [getHighlighted, item]);

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

  const extras = useMemo(
    () => (extraElements || []).filter(e => e.index === index).map(e => e.content),
    [extraElements, index],
  );

  return (
    <div style={style}>
      {extras}

      {dividers && <Divider />}

      <StyledListItem
        data-cy="list-item"
        disabled={!onClick && !onCheck && !onClickAction}
        selected={highlighted || false}
        onClick={onClick ? handleClick : undefined}
        dense={compact}
      >
        {checkboxSide !== 'right' && checkbox}

        {showIcons && icon && (
          <StyledListItemIcon faded={faded}>
            {icon}
          </StyledListItemIcon>
        )}

        <Box
          display="flex"
          flexDirection={{ xs: 'column', [TAG_ROW_BREAKPOINT]: 'row' }}
          flexGrow={1}
          minWidth={0}
        >
          <Box
            display="flex"
            alignItems="center"
            flexGrow={1}
            minWidth={0}
          >
            <StyledListItemText
              faded={faded}
              wrapText={wrapText}
              id={`${item.id}-text`}
              primary={title}
              secondary={description || undefined}
            />
          </Box>

          <Box flexGrow={1} />

          {showTags && isItem(item) && (
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
    </div>
  );
}
const MemoItemListItem = memo(ItemListItem) as typeof ItemListItem;

function ItemList<T extends Item>(props: MultipleItemsProps<T>) {
  const {
    getActionIcon,
    compact,
    checkboxes,
    checkboxSide,
    className,
    disablePadding,
    dividers,
    extraElements,
    fadeArchived = true,
    getChecked,
    getDescription,
    getForceFade,
    getHighlighted,
    getIcon,
    getTitle,
    items,
    linkTags = true,
    maxTags,
    noItemsHint,
    noItemsText,
    onClick,
    onClickAction,
    onCheck,
    paddingBottom,
    showIcons = false,
    showTags = true,
    viewHeight,
    wrapText,
  } = props;
  const tagsOnSameRow = useMediaQuery<Theme>(theme => theme.breakpoints.up(TAG_ROW_BREAKPOINT));

  const itemData: MostlyRequired<BaseProps<T>> = useMemo(
    () => ({
      items,
      getActionIcon,
      compact,
      checkboxSide,
      checkboxes,
      dividers,
      extraElements,
      fadeArchived,
      getChecked,
      getDescription,
      getForceFade,
      getHighlighted,
      getIcon,
      getTitle,
      linkTags,
      maxTags,
      onCheck,
      onClick,
      onClickAction,
      showIcons,
      showTags,
      wrapText,
    }),
    [
      getActionIcon,
      compact,
      checkboxSide,
      checkboxes,
      dividers,
      extraElements,
      fadeArchived,
      getChecked,
      getDescription,
      getForceFade,
      getHighlighted,
      getIcon,
      getTitle,
      items,
      linkTags,
      maxTags,
      onCheck,
      onClick,
      onClickAction,
      showIcons,
      showTags,
      wrapText,
    ],
  );

  const getItemKey: ListItemKeySelector<BaseProps<Item>> = useCallback(
    (index, data) => data.items[index].id,
    [],
  );
  const extraElementsByIndex = useMemo(
    () => items.map((_, index) => {
      const elementsForIndex = extraElements?.filter(ee => ee.index === index) || [];
      const elementsWithContent = elementsForIndex.filter(e => !!e.content);
      return {
        content: elementsWithContent.map(e => e.content),
        height: elementsWithContent.reduce((total, e) => total + e.height, 0),
      };
    }),
    [extraElements, items],
  );
  const itemHeights = useMemo(
    () => items.map(
      (item, index) => {
        const textHeight = 24;
        const descriptionHeight = (
          isItem(item)
          && (getDescription?.(item) || item.description)
            ? 20
            : 0
        );
        const textMargin = 6 * 2;
        const tagsHeight = !isItem(item) || item.tags.length === 0 || tagsOnSameRow ? 0 : 40;
        const padding = 8 * 2;
        const total = Math.max(
          (
            textHeight + descriptionHeight + textMargin
            + tagsHeight
            + padding
          ),
          MIN_ROW_HEIGHT,
        );
        const extraElementsHeight = extraElementsByIndex[index].height;
        return total + extraElementsHeight;
      },
    ),
    [extraElementsByIndex, getDescription, items, tagsOnSameRow],
  );
  const memoisedHeights = useStringMemo(itemHeights);
  const getItemSize = useCallback(
    (index: number) => memoisedHeights[index],
    [memoisedHeights],
  );

  const noStyle = useRef({});
  const listRef = useRef<VariableSizeList<BaseProps<Item>>>(null);

  const prevHeights = usePrevious(memoisedHeights);
  useEffect(
    () => {
      let firstChange = 0;
      if (prevHeights) {
        const length = Math.min(prevHeights.length, memoisedHeights.length);
        for (; firstChange < length; ++firstChange) {
          if (memoisedHeights[firstChange] !== prevHeights[firstChange]) {
            break;
          }
        }
        if (firstChange < length) {
          listRef.current?.resetAfterIndex(firstChange, true);
        }
      }
    },
    [listRef, memoisedHeights, prevHeights],
  );

  const rootStyles: SxProps = useMemo(() => ({ paddingBottom }), [paddingBottom]);

  return (
    <List
      className={className}
      disablePadding={disablePadding}
      sx={rootStyles}
    >
      {dividers && items.length === 0 && <Divider />}

      {items.length > 0 ? (
        viewHeight !== undefined ? (
          <VariableSizeList
            height={viewHeight}
            itemCount={items.length}
            itemData={itemData as unknown as BaseProps<Item>}
            itemKey={getItemKey}
            itemSize={getItemSize}
            width="100%"
            ref={listRef}
          >
            {MemoItemListItem}
          </VariableSizeList>
        ) : (
          items.map((item, index) => (
            <MemoItemListItem
              data={itemData}
              index={index}
              key={item.id}
              style={noStyle.current}
            />
          ))
        )
      ) : (
        <ListItem>
          <ListItemText primary={noItemsText} secondary={noItemsHint} />
        </ListItem>
      )}

      {dividers && <Divider />}
    </List>
  );
}

export default ItemList;
