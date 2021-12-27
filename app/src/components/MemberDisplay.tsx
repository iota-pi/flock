import {
  useCallback,
  useMemo,
} from 'react';
import makeStyles from '@mui/styles/makeStyles';
import DeleteIcon from '@mui/icons-material/Close';
import { GroupItem, Item, ItemId, PersonItem } from '../state/items';
import { useItems, useItemsById, useMaturity, useSortCriteria } from '../state/selectors';
import ItemList from './ItemList';
import ItemSearch from './ItemSearch';
import { useAppDispatch } from '../store';
import { pushActive } from '../state/ui';
import { sortItems } from '../utils/customSort';


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
  const people = useItems<PersonItem>('person');
  const [sortCriteria] = useSortCriteria();
  const [maturity] = useMaturity();

  const activePeople = useMemo(
    () => sortItems(people.filter(p => !p.archived), sortCriteria, maturity),
    [maturity, people, sortCriteria],
  );
  const members = useMemo(
    () => sortItems(getItemsById<PersonItem>(memberIds), sortCriteria, maturity),
    [getItemsById, maturity, memberIds, sortCriteria],
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
          items={activePeople}
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
