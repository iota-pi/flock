import React, {
  ChangeEvent,
  useCallback,
  useMemo,
} from 'react';
import { TextField } from '@material-ui/core';
import { Autocomplete, AutocompleteChangeReason, createFilterOptions } from '@material-ui/lab';
import DeleteIcon from '@material-ui/icons/Close';
import { compareNames, getItemName, lookupItemsById, GroupItem } from '../state/items';
import { useItems } from '../state/selectors';
import ItemList from './ItemList';


const filterFunc = createFilterOptions<GroupItem>({ trim: true });

export interface Props {
  groups: string[],
  onAdd: (group: GroupItem) => void,
  onClickGroup?: (group: GroupItem) => void,
  onRemove: (group: GroupItem) => void,
}


function GroupDisplay({
  groups: groupIds,
  onAdd,
  onClickGroup,
  onRemove,
}: Props) {
  const people = useItems<GroupItem>('group').sort(compareNames);

  const groups = useMemo(
    () => lookupItemsById(people, groupIds).sort(compareNames),
    [people, groupIds],
  );

  const options = useMemo(
    () => people.filter(person => !groupIds.includes(person.id)),
    [groupIds, people],
  );

  const handleRemoveGroup = useCallback(
    (group: GroupItem) => () => onRemove(group),
    [onRemove],
  );
  const handleChangeGroups = useCallback(
    (event: ChangeEvent<{}>, value: GroupItem[], reason: AutocompleteChangeReason) => {
      if (reason === 'select-option') {
        onAdd(value[0]);
      }
    },
    [onAdd],
  );

  return (
    <>
      <Autocomplete
        filterOptions={(opts, state) => (
          filterFunc(opts, state).filter(person => !groupIds.includes(person.id))
        )}
        getOptionLabel={item => getItemName(item)}
        multiple
        noOptionsText="No people found"
        onChange={handleChangeGroups}
        options={options}
        renderInput={params => (
          <TextField
            {...params}
            label="Add to group"
            variant="outlined"
          />
        )}
        renderOption={item => getItemName(item)}
        renderTags={() => null}
        value={[] as GroupItem[]}
      />

      <ItemList
        actionIcon={<DeleteIcon />}
        dividers
        items={groups}
        noItemsHint="Not in any groups"
        onClick={onClickGroup ? (item => () => onClickGroup(item)) : undefined}
        onClickAction={handleRemoveGroup}
      />
    </>
  );
}

export default GroupDisplay;
