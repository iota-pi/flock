import React, { useMemo } from 'react';
import { makeStyles, Typography } from '@material-ui/core';
import {
  compareNames,
  getItemName,
  GroupItem,
  Item,
} from '../../state/items';
import MemberDisplay from '../MemberDisplay';
import { useItems } from '../../state/selectors';

const useStyles = makeStyles(theme => ({
  section: {
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
  },
}));

export interface Props {
  item: Item,
}


function ItemReport({
  item,
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
      <Typography variant="h3">
        {getItemName(item)}
      </Typography>

      {item.description && (
        <Typography paragraph>
          {item.description}
        </Typography>
      )}

      {item.type === 'person' && (
        <div className={classes.section}>
          <Typography variant="h4">
            Members
          </Typography>

          <MemberDisplay
            editable={false}
            members={memberGroupIds}
            onChange={() => {}}
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
