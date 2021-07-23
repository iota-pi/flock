import React from 'react';
import {
  makeStyles,
  Typography,
} from '@material-ui/core';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import LargeIcon from '../LargeIcon';
import { InternalPageId, PageId, usePage } from '../pages';

const useStyles = makeStyles(() => ({
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    opacity: 0.75,
  },
}));

export interface Props extends BaseDrawerProps {}

const pagesWithAddButton: PageId[] = [
  'general',
  'groups',
  'people',
  'prayer-points',
  'interactions',
];

const itemNameMap: Record<Exclude<PageId, InternalPageId>, string> = {
  general: 'item',
  groups: 'group',
  people: 'person',
  interactions: 'interaction',
  prayer: 'item',
  'prayer-points': 'prayer point',
  suggestions: 'item',
};

function PlaceholderDrawer({
  alwaysTemporary,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const page = usePage();
  console.error(page);

  const canAdd = pagesWithAddButton.includes(page.id);
  const itemName = itemNameMap[page.id] || 'item';
  const aOrAn = 'aeiou'.includes(itemName.charAt(0)) ? 'an' : 'a';

  return (
    <>
      <BaseDrawer
        alwaysTemporary={alwaysTemporary}
        onClose={onClose}
        open={open}
        stacked={stacked}
      >
        <div className={classes.placeholder}>
          <LargeIcon icon={page.icon} />

          <Typography variant="h5" color="textSecondary" align="center">
            Select {aOrAn} {itemName} from the list<br />
            {canAdd ? (
              <span>
                or click the + to add a new {itemName}
              </span>
            ) : (
              <span>
                to view details
              </span>
            )}
          </Typography>
        </div>
      </BaseDrawer>
    </>
  );
}

export default PlaceholderDrawer;
