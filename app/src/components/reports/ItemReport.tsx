import React, { useMemo } from 'react';
import { IconButton, makeStyles, Typography } from '@material-ui/core';
import {
  compareNames,
  getItemName,
  GroupItem,
  Item,
} from '../../state/items';
import MemberDisplay from '../MemberDisplay';
import { useItems } from '../../state/selectors';
import GroupDisplay from '../GroupDisplay';
import { EditIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  heading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  section: {
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
  },
}));

interface BaseProps {
  item: Item,
}

interface PropsWithEdit extends BaseProps {
  canEdit: true,
  onEdit: () => void,
}

interface PropsNoEdit extends BaseProps {
  canEdit?: false,
  onEdit?: () => void,
}

export type Props = PropsWithEdit | PropsNoEdit;


function ItemReport({
  canEdit,
  item,
  onEdit,
}: Props) {
  const classes = useStyles();
  const groups = useItems<GroupItem>('group');

  const memberGroupIds = useMemo(
    () => {
      if (item.type === 'person') {
        const memberGroups = groups.filter(g => g.members.includes(item.id));
        memberGroups.sort(compareNames);
        return memberGroups.map(g => g.id);
      }
      return [];
    },
    [groups, item],
  );

  return (
    <>
      <div className={classes.heading}>
        <Typography variant="h3">
          {getItemName(item)}
        </Typography>

        {canEdit && (
          <IconButton onClick={onEdit}>
            <EditIcon />
          </IconButton>
        )}
      </div>

      {item.description && (
        <Typography paragraph>
          {item.description}
        </Typography>
      )}

      {item.type === 'person' && (
        <div className={classes.section}>
          <Typography variant="h4">
            Groups
          </Typography>

          <GroupDisplay
            editable={false}
            groups={memberGroupIds}
            onAdd={() => {}}
            onRemove={() => {}}
          />
        </div>
      )}

      {item.type === 'group' && (
        <div className={classes.section}>
          <Typography variant="h4">
            Members
          </Typography>

          <MemberDisplay
            editable={false}
            members={item.members}
            onChange={() => {}}
          />
        </div>
      )}

      {'<insert maturity, attendance, and other fun things here />'}
    </>
  );
}

export default ItemReport;
