import {
  ChangeEvent,
  createContext,
  ForwardedRef,
  forwardRef,
  HTMLAttributes,
  memo,
  PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
} from 'react';
import { ListChildComponentProps, VariableSizeList } from 'react-window';
import {
  Autocomplete,
  autocompleteClasses,
  Chip,
  Popper,
  styled,
  TextField,
  Typography,
} from '@mui/material';
import {
  AutocompleteChangeReason,
  createFilterOptions,
} from '@mui/material/useAutocomplete';
import makeStyles from '@mui/styles/makeStyles';
import {
  getItemName,
  Item,
  ItemId,
} from '../state/items';
import { getIcon } from './Icons';
import { useItemsById } from '../state/selectors';
import { useResetCache } from '../utils/virtualisation';

const LISTBOX_PADDING = 8;

const useStyles = makeStyles(theme => ({
  autocompleteOption: {
    display: 'flex',
    alignItems: 'center',
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(1),
  },
  optionIcon: {
    display: 'flex',
    alignItems: 'center',
    paddingRight: theme.spacing(2),
  },
  faded: {
    opacity: 0.85,
    fontWeight: 300,
  },
  itemChip: {
    marginRight: theme.spacing(1),
    marginTop: theme.spacing(0.25),
    marginBottom: theme.spacing(0.25),
  },
}));

interface ItemOptionProps {
  item: Item,
  showGroupMemberCount: boolean,
  showIcons: boolean,
}

function ItemOption({
  item,
  showGroupMemberCount,
  showIcons,
}: ItemOptionProps) {
  const classes = useStyles();
  const groupMembers = item.type === 'group' ? item.members.length : 0;
  const plural = groupMembers !== 1 ? 's' : '';
  const groupMembersText = ` (${groupMembers} member${plural})`;

  const clippedDescription = useMemo(
    () => {
      const base = item.description;
      const clipped = base.slice(0, 100);
      if (clipped.length < base.length) {
        const clippedToWord = clipped.slice(0, clipped.lastIndexOf(' '));
        return `${clippedToWord}…`;
      }
      return base;
    },
    [item.description],
  );

  return (
    <div className={classes.autocompleteOption}>
      {showIcons && (
        <div className={classes.optionIcon}>
          {getIcon(item.type)}
        </div>
      )}

      <div>
        <Typography>
          {getItemName(item)}

          <span className={classes.faded}>
            {showGroupMemberCount && item.type === 'group' ? groupMembersText : ''}
          </span>
        </Typography>

        {clippedDescription && (
          <Typography color="textSecondary">
            {clippedDescription}
          </Typography>
        )}
      </div>
    </div>
  );
}

type PropsAndItemList = [HTMLAttributes<HTMLLIElement>, ItemOptionProps][];

const SearchableRow = memo((
  props: ListChildComponentProps<PropsAndItemList>,
) => {
  const { data, index, style } = props;
  const [optionProps, itemData] = data[index];
  const inlineStyle = {
    ...style,
    top: (style.top as number) + LISTBOX_PADDING,
  };
  const { item, showGroupMemberCount, showIcons } = itemData;

  return (
    <li
      {...optionProps}
      key={item.id}
      style={inlineStyle}
    >
      <ItemOption
        item={item}
        showGroupMemberCount={showGroupMemberCount}
        showIcons={showIcons}
      />
    </li>
  );
});
SearchableRow.displayName = 'SearchableRow';

const OuterElementContext = createContext({});

const OuterElementType = forwardRef<HTMLDivElement>((props, ref) => {
  const outerProps = useContext(OuterElementContext);
  return <div ref={ref} {...props} {...outerProps} />;
});
OuterElementType.displayName = 'OuterElementType';

const ListBoxComponent = forwardRef(
  (
    props: PropsWithChildren<HTMLAttributes<HTMLElement>>,
    ref: ForwardedRef<HTMLDivElement>,
  ) => {
    const { children, ...otherProps } = props;
    const itemData = children as PropsAndItemList;
    const itemSize = 56;

    const gridRef = useResetCache(itemData.length);
    const getHeight = useCallback(
      () => itemSize * Math.min(itemData.length, 6),
      [itemData, itemSize],
    );

    return (
      <div ref={ref}>
        <OuterElementContext.Provider value={otherProps}>
          <VariableSizeList<PropsAndItemList>
            itemData={itemData}
            height={getHeight() + 2 * LISTBOX_PADDING}
            width="100%"
            ref={gridRef}
            outerElementType={OuterElementType}
            innerElementType="ul"
            itemSize={() => itemSize}
            overscanCount={2}
            itemCount={itemData.length}
          >
            {SearchableRow}
          </VariableSizeList>
        </OuterElementContext.Provider>
      </div>
    );
  },
);
ListBoxComponent.displayName = 'ListBoxComponent';

const StyledPopper = styled(Popper)({
  [`& .${autocompleteClasses.listbox}`]: {
    boxSizing: 'border-box',
    '& ul': {
      padding: 0,
      margin: 0,
    },
  },
});

export interface Props<T extends Item> {
  autoFocus?: boolean,
  dataCy?: string,
  items: T[],
  label: string,
  noItemsText?: string,
  onClear?: () => void,
  onRemove?: (item: T) => void,
  onSelect: (item: T) => void,
  selectedIds: ItemId[],
  showGroupMemberCount?: boolean,
  showIcons?: boolean,
  showSelected?: boolean,
}

function ItemSearch<T extends Item = Item>({
  autoFocus = false,
  dataCy,
  items,
  label,
  noItemsText,
  onClear,
  onRemove,
  onSelect,
  selectedIds,
  showGroupMemberCount = false,
  showIcons = false,
  showSelected = true,
}: Props<T>) {
  const classes = useStyles();
  const getItemsById = useItemsById();
  const filterFunc = useMemo(
    () => createFilterOptions<T>({ trim: true }),
    [],
  );
  const options = useMemo(
    () => (showSelected !== false ? items : items.filter(item => !selectedIds.includes(item.id))),
    [items, selectedIds, showSelected],
  );
  const selectedItems = useMemo(
    () => getItemsById<T>(selectedIds),
    [getItemsById, selectedIds],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<{}>, value: T[], reason: AutocompleteChangeReason) => {
      if (reason === 'selectOption') {
        onSelect(value[value.length - 1]);
      }
      if (onRemove && reason === 'removeOption') {
        const deletedItems = selectedItems.filter(item => !value.find(i => i.id === item.id));
        onRemove(deletedItems[0]);
      }
      if (onClear && reason === 'clear') {
        onClear();
      }
    },
    [onClear, onRemove, onSelect, selectedItems],
  );
  const handleRemove = useCallback(
    (item: T) => (onRemove ? onRemove(item) : undefined),
    [onRemove],
  );

  return (
    <Autocomplete
      autoHighlight
      disableListWrap
      filterOptions={filterFunc}
      getOptionLabel={item => getItemName(item)}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      ListboxComponent={ListBoxComponent}
      multiple
      noOptionsText={noItemsText || 'No items found'}
      onChange={handleChange}
      options={options}
      PopperComponent={StyledPopper}
      renderInput={params => (
        <TextField
          {...params}
          autoFocus={autoFocus}
          data-cy={dataCy}
          label={label}
          variant="outlined"
        />
      )}
      renderOption={(props, item) => [props, { item, showGroupMemberCount, showIcons }]}
      renderTags={itemsToRender => (
        itemsToRender.map(item => (
          <Chip
            key={item.id}
            label={getItemName(item)}
            icon={getIcon(item.type)}
            onDelete={handleRemove}
            className={classes.itemChip}
          />
        ))
      )}
      value={showSelected ? selectedItems : [] as T[]}
    />
  );
}

export default ItemSearch;
