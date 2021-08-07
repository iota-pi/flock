import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import {
  Checkbox,
  FormControlLabel,
  Grid,
  makeStyles,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import {
  cleanItem,
  compareNames,
  dirtyItem,
  DirtyItem,
  GeneralItem,
  getItemName,
  getItemTypeLabel,
  GroupItem,
  Item,
  ItemNote,
  PersonItem,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteControl from '../NoteControl';
import { useItems, useVault } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import FrequencyControls from '../FrequencyControls';
import TagSelection from '../TagSelection';
import CollapsibleSections, { CollapsibleSection } from './utils/CollapsibleSections';
import GroupDisplay from '../GroupDisplay';
import MemberDisplay from '../MemberDisplay';
import { pushActive } from '../../state/ui';
import { usePrevious } from '../../utils';
import { FrequencyIcon, GroupIcon, InteractionIcon, PersonIcon, PrayerIcon } from '../Icons';

const useStyles = makeStyles(theme => ({
  alert: {
    transition: theme.transitions.create('all'),
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props extends BaseDrawerProps {
  item: DirtyItem<Item>,
  onChange: (item: DirtyItem<Item>) => void,
}

export interface ItemAndChangeCallback {
  item: Item,
  handleChange: <S extends Item>(data: Partial<Omit<S, 'type' | 'id'>>) => void,
}

function DuplicateAlert({ item, count }: { item: Item, count: number }) {
  const classes = useStyles();

  const plural = count > 1;
  const areOrIs = plural ? 'are' : 'is';

  return (
    <Alert
      className={classes.alert}
      severity={item.description ? 'info' : 'warning'}
    >
      <Typography paragraph={!item.description}>
        There {areOrIs} <span className={classes.emphasis}>{count}</span>
        {' other '}
        {getItemTypeLabel(item.type, plural).toLowerCase()}
        {' with this name.'}
      </Typography>

      {!item.description && (
        <Typography>
          Please check if this is a duplicate.
          Otherwise, it may be helpful to
          {' '}
          <span className={classes.emphasis}>add a description</span>
          {' '}
          to help distinguish between these {getItemTypeLabel(item.type, true).toLowerCase()}.
        </Typography>
      )}
    </Alert>
  );
}

export function getSections(
  { item, handleChange }: ItemAndChangeCallback,
): CollapsibleSection[] {
  const sections: CollapsibleSection[] = [
    {
      icon: FrequencyIcon,
      id: 'frequencies',
      title: 'Prayer and interaction frequencies',
      content: (
        <FrequencyControls
          item={item}
          onChange={handleChange}
        />
      ),
    },
  ];

  if (item.type === 'person') {
    sections.push(
      {
        icon: GroupIcon,
        id: 'group-display',
        title: 'Groups',
        content: (
          <GroupDisplay item={item} />
        ),
      },
    );
  }

  if (item.type === 'group') {
    sections.push(
      {
        icon: PersonIcon,
        id: 'member-display',
        title: 'Members',
        content: (
          <MemberDisplay
            item={item}
            onChange={group => handleChange<GroupItem>(group)}
          />
        ),
      },
    );
  }

  sections.push(
    {
      icon: PrayerIcon,
      id: 'prayer-points',
      title: 'Prayer points',
      content: (
        <NoteControl
          noNotesText="No prayer points"
          notes={item.notes}
          onChange={(notes: ItemNote[]) => handleChange({ notes })}
          noteType="prayer"
        />
      ),
    },
  );

  if (item.type === 'person') {
    sections.push(
      {
        icon: InteractionIcon,
        id: 'interactions',
        title: 'Interactions',
        content: (
          <NoteControl
            noNotesText="No interactions"
            notes={item.notes}
            onChange={(notes: ItemNote[]) => handleChange({ notes })}
            noteType="interaction"
          />
        ),
      },
    );
  }

  return sections;
}

function getValue(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
  return event.target.value;
}


function ItemDrawer({
  alwaysTemporary,
  item,
  onBack,
  onChange,
  onClose,
  onExited,
  open,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const groups = useItems<GroupItem>('group');
  const items = useItems();
  const vault = useVault();

  const prevItem = usePrevious(item);

  const memberGroups = useMemo(
    () => (
      item.type === 'person'
        ? groups.filter(g => g.members.includes(item.id)).sort(compareNames)
        : []
    ),
    [item.id, item.type, groups],
  );

  const duplicates = useMemo(
    () => items.filter(
      i => (
        i.type === item.type
        && i.id !== item.id
        && getItemName(i) === getItemName(item)
      ),
    ),
    [item, items],
  );

  const handleChange = useCallback(
    <S extends Item>(data: Partial<Omit<S, 'type' | 'id'>>) => (
      onChange(dirtyItem({ ...item, ...data }))
    ),
    [item, onChange],
  );

  const sections = useMemo(
    () => getSections({ item, handleChange }),
    [item, handleChange],
  );

  const isValid = useCallback(
    (currentItem: Item) => {
      if (currentItem.type === 'person') {
        return !!currentItem.firstName.trim();
      }
      return !!getItemName(currentItem).trim();
    },
    [],
  );

  const removeFromAllGroups = useCallback(
    () => {
      const updatedGroupItems: GroupItem[] = [];
      for (const group of memberGroups) {
        const newGroup: GroupItem = {
          ...group,
          members: group.members.filter(m => m !== item.id),
        };
        updatedGroupItems.push(newGroup);
      }
      vault?.store(updatedGroupItems);
    },
    [item.id, memberGroups, vault],
  );

  const handleSave = useCallback(
    async (itemToSave: DirtyItem<Item>) => {
      if ((itemToSave.dirty || itemToSave.isNew) && isValid(itemToSave)) {
        const clean = cleanItem(itemToSave);
        vault?.store(clean);
      }
    },
    [isValid, vault],
  );
  const handleSaveAndClose = useCallback(
    async () => {
      handleSave(item);
      onClose();
    },
    [handleSave, item, onClose],
  );
  const handleDelete = useCallback(
    () => {
      removeFromAllGroups();
      vault?.delete(item.id);
      onClose();
    },
    [onClose, item.id, removeFromAllGroups, vault],
  );

  const hasReport = item.type === 'group';
  const handleReport = useCallback(
    () => dispatch(pushActive({ item, report: true })),
    [dispatch, item],
  );

  useEffect(
    () => {
      if (open && prevItem && prevItem.id !== item.id) {
        handleSave(prevItem);
      }
    },
    [handleSave, item.id, open, prevItem],
  );

  return (
    <BaseDrawer
      ActionProps={{
        canSave: isValid(item),
        editing: !item.isNew,
        itemName: getItemName(item),
        onCancel: onClose,
        onDelete: handleDelete,
        onReport: hasReport ? handleReport : undefined,
        onSave: handleSaveAndClose,
      }}
      alwaysTemporary={alwaysTemporary}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      open={open}
      stacked={stacked}
    >
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Typography variant="h5">
            Basic details
          </Typography>
        </Grid>

        {duplicates.length > 0 && (
          <Grid item xs={12}>
            <DuplicateAlert item={item} count={duplicates.length} />
          </Grid>
        )}

        {item.type === 'person' ? (
          <>
            <Grid item xs={6}>
              <TextField
                autoFocus
                fullWidth
                key={item.id}
                label="First Name"
                onChange={event => handleChange<PersonItem>({ firstName: getValue(event) })}
                required
                value={item.firstName}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField
                fullWidth
                label="Last Name"
                onChange={event => handleChange<PersonItem>({ lastName: getValue(event) })}
                value={item.lastName}
              />
            </Grid>
          </>
        ) : (
          <Grid item xs={6}>
            <TextField
              autoFocus
              fullWidth
              key={item.id}
              label="Name"
              onChange={
                event => handleChange<GeneralItem | GroupItem>({ name: getValue(event) })
              }
              required
              value={item.name}
            />
          </Grid>
        )}

        {item.type === 'person' && (
          <>
            <Grid item xs={6}>
              <TextField
                fullWidth
                label="Email"
                onChange={event => handleChange<PersonItem>({ email: getValue(event) })}
                value={item.email}
              />
            </Grid>

            <Grid item xs={6}>
              <TextField
                fullWidth
                label="Phone"
                onChange={event => handleChange<PersonItem>({ phone: getValue(event) })}
                value={item.phone}
              />
            </Grid>
          </>
        )}

        <Grid item xs={12}>
          <TextField
            value={item.description}
            onChange={event => handleChange({ description: getValue(event) })}
            label="Description"
            fullWidth
          />
        </Grid>

        <Grid item xs={12}>
          <TextField
            value={item.summary}
            onChange={event => handleChange({ summary: getValue(event) })}
            label="Notes"
            multiline
            fullWidth
          />
        </Grid>

        <Grid item xs={12}>
          <FormControlLabel
            control={(
              <Checkbox
                checked={item.archived}
                onChange={(_, archived) => handleChange({ archived })}
              />
            )}
            label="Archived"
          />
        </Grid>

        <Grid item xs={12}>
          <TagSelection
            selectedTags={item.tags}
            onChange={tags => handleChange({ tags })}
          />
        </Grid>

        <CollapsibleSections
          sections={sections}
          initialExpandAll={item.isNew}
        />
      </Grid>
    </BaseDrawer>
  );
}

export default ItemDrawer;
