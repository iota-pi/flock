import {
  ChangeEvent,
  useCallback,
  useMemo,
} from 'react';
import { Autocomplete, Chip, TextField, Typography } from '@material-ui/core';
import { AutocompleteChangeReason, createFilterOptions } from '@material-ui/core/useAutocomplete';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  getItemName,
  Item,
  ItemId,
} from '../state/items';
import { getIcon } from './Icons';
import { useItemsById } from '../state/selectors';

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

function ItemOption({
  item,
  showIcons,
  showGroupMemberCount,
}: {
  item: Item,
  showIcons: boolean,
  showGroupMemberCount: boolean,
}) {
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
      filterOptions={filterFunc}
      getOptionLabel={item => getItemName(item)}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      multiple
      noOptionsText={noItemsText || 'No items found'}
      onChange={handleChange}
      options={options}
      renderInput={params => (
        <TextField
          {...params}
          autoFocus={autoFocus}
          data-cy={dataCy}
          label={label}
          variant="outlined"
        />
      )}
      renderOption={(props, item) => (
        <li {...props} key={item.id}>
          <ItemOption
            item={item}
            showIcons={showIcons}
            showGroupMemberCount={showGroupMemberCount}
          />
        </li>
      )}
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
