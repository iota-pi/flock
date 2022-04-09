import {
  useCallback,
  useMemo,
} from 'react';
import makeStyles from '@mui/styles/makeStyles';
import DeleteIcon from '@mui/icons-material/Close';
import { GroupItem, Item, ItemId, PersonItem } from '../state/items';
import { useItemsById, useMaturity, useSortCriteria } from '../state/selectors';
import ItemList from './ItemList';
import { useAppDispatch } from '../store';
import { pushActive } from '../state/ui';
import { sortItems } from '../utils/customSort';
import Search from './Search';


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
  const [sortCriteria] = useSortCriteria();
  const [maturity] = useMaturity();

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
        <Search<PersonItem>
          dataCy="members"
          label="Add group members"
          noItemsText="No people found"
          onSelect={handleChangeMembers}
          selectedItems={members}
          types={{ person: true }}
          searchDescription
        />
      )}

      <ItemList
        className={classes.list}
        compact
        dividers
        getActionIcon={editable ? () => <DeleteIcon /> : undefined}
        items={members}
        noItemsHint="No group members"
        onClick={handleClickItem}
        onClickAction={editable ? handleRemoveMember : undefined}
        showIcons
      />
    </>
  );
}

export default MemberDisplay;
