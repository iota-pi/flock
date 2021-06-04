import React, {
  useCallback,
  useMemo,
} from 'react';
import DeleteIcon from '@material-ui/icons/Close';
import { comparePeopleNames, Item, lookupItemsById, PersonItem } from '../state/items';
import { useItems } from '../state/selectors';
import ItemList from './ItemList';
import ItemSearch from './ItemSearch';

export interface Props {
  members: string[],
  onChange: (members: string[]) => void,
  onClickMember?: (member: PersonItem) => void,
}

function MemberDisplay({
  members: memberIds,
  onChange,
  onClickMember,
}: Props) {
  const people = useItems<PersonItem>('person').sort(comparePeopleNames);

  const members = useMemo(
    () => lookupItemsById(people, memberIds).sort(comparePeopleNames),
    [people, memberIds],
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
    (item?: Item) => {
      if (item) {
        onChange([...memberIds, item.id]);
      }
    },
    [onChange, memberIds],
  );

  return (
    <>
      <ItemSearch
        selectedIds={memberIds}
        items={people}
        label="Add group members"
        onSelect={handleChangeMembers}
        showSelected={false}
      />

      <ItemList
        actionIcon={<DeleteIcon />}
        dividers
        items={members}
        noItemsHint="No members found"
        onClick={onClickMember ? (item => () => onClickMember(item)) : undefined}
        onClickAction={handleRemoveMember}
      />
    </>
  );
}

export default MemberDisplay;
