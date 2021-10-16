import {
  useCallback,
  useMemo,
} from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import DeleteIcon from '@material-ui/icons/Close';
import { compareItems, GroupItem, Item, ItemId, PersonItem } from '../state/items';
import { useItems, useItemsById } from '../state/selectors';
import ItemList from './ItemList';
import ItemSearch from './ItemSearch';
import { useAppDispatch } from '../store';
import { pushActive } from '../state/ui';


const useStyles = makeStyles(() => ({
  list: {
    paddingBottom: 0,
  },
}));

export interface Props {
  editable?: boolean,
  memberIds: ItemId[],
  onChange: (item: Partial<Pick<GroupItem, 'members'>>) => void,
}

function MemberDisplay({
  editable = true,
  memberIds,
  onChange,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const getItemsById = useItemsById();
  const people = useItems<PersonItem>('person').sort(compareItems);

  const members = useMemo(
    () => getItemsById<PersonItem>(memberIds).sort(compareItems),
    [getItemsById, memberIds],
  );

  const handleClickItem = useCallback(
    (item: PersonItem) => {
      dispatch(pushActive({ item: item.id }));
    },
    [dispatch],
  );
  const handleRemoveMember = useCallback(
    (member: PersonItem) => {
      onChange({ members: memberIds.filter(m => m !== member.id) });
    },
    [memberIds, onChange],
  );
  const handleChangeMembers = useCallback(
    (item?: Item) => {
      if (item) {
        onChange({ members: [...memberIds, item.id] });
      }
    },
    [memberIds, onChange],
  );

  return (
    <>
      {editable && (
        <ItemSearch
          dataCy="members"
          items={people}
          label="Add group members"
          noItemsText="No people found"
          onSelect={handleChangeMembers}
          selectedIds={memberIds}
          showSelected={false}
        />
      )}

      <ItemList
        className={classes.list}
        dividers
        getActionIcon={editable ? () => <DeleteIcon /> : undefined}
        items={members}
        noItemsHint="No group members"
        onClick={handleClickItem}
        onClickAction={editable ? handleRemoveMember : undefined}
      />
    </>
  );
}

export default MemberDisplay;
