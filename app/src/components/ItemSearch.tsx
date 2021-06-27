import React, {
  ChangeEvent,
  useCallback,
  useMemo,
} from 'react';
import { TextField } from '@material-ui/core';
import { Autocomplete, AutocompleteChangeReason, createFilterOptions } from '@material-ui/lab';
import {
  getItemName,
  Item,
  ItemId,
  lookupItemsById,
} from '../state/items';


export interface Props<T extends Item> {
  autoFocus?: boolean,
  items: T[],
  label: string,
  noItemsText?: string,
  onSelect: (item?: T) => void,
  selectedIds: ItemId[],
  showSelected?: boolean,
}

function ItemSearch<T extends Item = Item>({
  autoFocus = false,
  items,
  label,
  noItemsText,
  onSelect,
  selectedIds,
  showSelected = true,
}: Props<T>) {
  const filterFunc = useMemo(
    () => createFilterOptions<T>({ trim: true }),
    [],
  );
  const options = useMemo(
    () => (showSelected !== false ? items : items.filter(item => !selectedIds.includes(item.id))),
    [items, selectedIds, showSelected],
  );
  const selectedItems = lookupItemsById(items, selectedIds);

  const handleChange = useCallback(
    (event: ChangeEvent<{}>, value: T[], reason: AutocompleteChangeReason) => {
      if (reason === 'select-option') {
        onSelect(value[value.length - 1]);
      }
      if (reason === 'remove-option' || reason === 'clear') {
        onSelect(undefined);
      }
    },
    [onSelect],
  );

  return (
    <Autocomplete
      filterOptions={filterFunc}
      getOptionLabel={item => getItemName(item)}
      multiple
      noOptionsText={noItemsText || 'No items found'}
      onChange={handleChange}
      options={options}
      getOptionSelected={(a, b) => a.id === b.id}
      renderInput={params => (
        <TextField
          {...params}
          autoFocus={autoFocus}
          label={label}
          variant="outlined"
        />
      )}
      renderOption={item => getItemName(item)}
      value={showSelected ? selectedItems : [] as T[]}
    />
  );
}

export default ItemSearch;
