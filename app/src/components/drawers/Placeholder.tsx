import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import LargeIcon from '../LargeIcon';
import { InternalPageId, PageId, usePage } from '../pages';
import InlineText from '../InlineText';

export interface Props extends BaseDrawerProps {}

const pagesWithAddButton: PageId[] = [
  'general',
  'groups',
  'people',
  'prayer',
];

const itemNameMap: Record<Exclude<PageId, InternalPageId>, string> = {
  general: 'item',
  groups: 'group',
  people: 'person',
  prayer: 'item',
  communication: 'message',
  settings: 'item',
};
const addNameMap: Record<Exclude<PageId, InternalPageId>, string> = {
  general: 'item',
  groups: 'group',
  people: 'person',
  prayer: 'prayer point',
  communication: 'message',
  settings: 'item',
};

function PlaceholderDrawer({
  alwaysTemporary,
  onClose,
  open,
  stacked,
}: Props) {
  const page = usePage();

  const canAdd = pagesWithAddButton.includes(page.id);
  const itemName = itemNameMap[page.id] || 'item';
  const addName = addNameMap[page.id] || 'item';
  const aOrAn = 'aeiou'.includes(itemName.charAt(0)) ? 'an' : 'a';

  const styles = useMemo(
    () => ({ opacity: 0.75 }),
    [],
  );

  return (
    <BaseDrawer
      alwaysTemporary={alwaysTemporary}
      hideTypeIcon
      onClose={onClose}
      open={open}
      stacked={stacked}
    >
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
        sx={styles}
      >
        <LargeIcon icon={page.icon} />

        <Typography variant="h5" color="textSecondary" align="center">
          Select {aOrAn} {itemName} from the list<br />
          {canAdd ? (
            <span>
              or click the
              {' '}
              <InlineText
                fontSize="h5.fontSize"
                fontWeight={700}
              >
                +
              </InlineText>
              {' '}
              to add a new {addName}
            </span>
          ) : (
            <span>
              to view details
            </span>
          )}
        </Typography>
      </Box>
    </BaseDrawer>
  );
}

export default PlaceholderDrawer;
