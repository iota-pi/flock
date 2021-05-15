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
} from '../state/items';


const filterFunc = createFilterOptions<Item>({ trim: true });

export interface Props {
  filterIds: ItemId[],
  items: Item[],
  onSelect: (item: Item) => void,
  renderTags?: boolean,
}

function ItemSearch({
  filterIds,
  items,
  onSelect,
  renderTags,
}: Props) {
  const options = useMemo(
    () => items.filter(item => !filterIds.includes(item.id)),
    [filterIds, items],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<{}>, value: Item[], reason: AutocompleteChangeReason) => {
      if (reason === 'select-option') {
        onSelect(value[0]);
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
      renderInput={params => (
        <TextField
          {...params}
          label="Add group members"
          variant="outlined"
        />
      )}
      renderOption={item => getItemName(item)}
      renderTags={renderTags === false ? () => null : undefined}
      value={[] as Item[]}
    />
  );
}

export default ItemSearch;
