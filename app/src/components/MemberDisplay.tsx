import React, {
  ChangeEvent,
  useCallback,
  useMemo,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { TextField } from '@material-ui/core';
import { Autocomplete, AutocompleteChangeReason, createFilterOptions } from '@material-ui/lab';
import DeleteIcon from '@material-ui/icons/Close';
import { comparePeopleNames, getItemName, lookupItemsById, PersonItem } from '../state/items';
import { useItems } from '../state/selectors';
import ItemList from './ItemList';


const useStyles = makeStyles(theme => ({
  memberList: {
    backgroundColor: theme.palette.background.paper,
  },
}));

const filterFunc = createFilterOptions<PersonItem>({ trim: true });

export interface Props {
  members: string[],
  onChange: (members: string[]) => void,
}


function MemberDisplay({
  members: memberIds,
  onChange,
}: Props) {
  const classes = useStyles();
  const people = useItems<PersonItem>('person').sort(comparePeopleNames);

  const members = useMemo(
    () => lookupItemsById(people, memberIds).sort(comparePeopleNames),
    [people, memberIds],
  );

  const options = useMemo(
    () => people.filter(person => !memberIds.includes(person.id)),
    [memberIds, people],
  );

  const handleRemoveMember = useCallback(
    (member: PersonItem) => (
      () => {
        onChange(memberIds.filter(m => m !== member.id));
      }
    ),
    [onChange, memberIds],
  );
  const handleChangeMembers = useCallback(
    (event: ChangeEvent<{}>, value: PersonItem[], reason: AutocompleteChangeReason) => {
      if (reason === 'select-option') {
        onChange([...memberIds, value[0].id]);
      }
    },
    [onChange, memberIds],
  );

  return (
    <>
      <Autocomplete
        filterOptions={(opts, state) => (
          filterFunc(opts, state).filter(person => !memberIds.includes(person.id))
        )}
        getOptionLabel={item => getItemName(item)}
        multiple
        noOptionsText="No people found"
        onChange={handleChangeMembers}
        options={options}
        renderInput={params => (
          <TextField
            {...params}
            label="Add group members"
            variant="outlined"
          />
        )}
        renderOption={item => getItemName(item)}
        renderTags={() => null}
        value={[] as PersonItem[]}
      />

      <ItemList
        actionIcon={<DeleteIcon />}
        className={classes.memberList}
        dividers
        items={members}
        noItemsText="No members found"
        onClick={() => () => {}}
        onClickAction={handleRemoveMember}
      />
    </>
  );
}

export default MemberDisplay;
