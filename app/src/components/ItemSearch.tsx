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


const filterFunc = createFilterOptions<Item>({ trim: true });

export interface Props {
  selectedIds: ItemId[],
  items: Item[],
  label: string,
  onSelect: (item?: Item) => void,
  showSelected?: boolean,
}

function ItemSearch({
  selectedIds,
  items,
  label,
  onSelect,
  showSelected,
}: Props) {
  const options = useMemo(
    () => (showSelected !== false ? items : items.filter(item => !selectedIds.includes(item.id))),
    [items, selectedIds, showSelected],
  );
  const selectedItems = lookupItemsById(items, selectedIds);

  const handleChange = useCallback(
    (event: ChangeEvent<{}>, value: Item[], reason: AutocompleteChangeReason) => {
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
      noOptionsText="No people found"
      onChange={handleChange}
      options={options}
      getOptionSelected={(a, b) => a.id === b.id}
      renderInput={params => (
        <TextField
          {...params}
          label={label}
          variant="outlined"
        />
      )}
      renderOption={item => getItemName(item)}
      value={showSelected === false ? [] as Item[] : selectedItems}
    />
  );
}

export default ItemSearch;
