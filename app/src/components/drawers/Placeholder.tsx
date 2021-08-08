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
  bold: {
    fontWeight: 700,
  },
}));

export interface Props extends BaseDrawerProps {}

const pagesWithAddButton: PageId[] = [
  'general',
  'groups',
  'people',
  'prayer',
  'interactions',
  'actions',
];

const itemNameMap: Record<Exclude<PageId, InternalPageId>, string> = {
  general: 'item',
  groups: 'group',
  people: 'person',
  interactions: 'item',
  prayer: 'item',
  actions: 'item',
};
const addNameMap: Record<Exclude<PageId, InternalPageId>, string> = {
  general: 'item',
  groups: 'group',
  people: 'person',
  interactions: 'interaction',
  prayer: 'prayer point',
  actions: 'action point',
};

function PlaceholderDrawer({
  alwaysTemporary,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const page = usePage();

  const canAdd = pagesWithAddButton.includes(page.id);
  const itemName = itemNameMap[page.id] || 'item';
  const addName = addNameMap[page.id] || 'item';
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
                or click the
                {' '}
                <span className={classes.bold}>+</span>
                {' '}
                to add a new {addName}
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
