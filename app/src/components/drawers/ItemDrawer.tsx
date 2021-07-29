import React, {
  ChangeEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import {
  Checkbox,
  FormControlLabel,
  Grid,
  GridSize,
  TextField,
  Typography,
} from '@material-ui/core';
import { Breakpoint } from '@material-ui/core/styles/createBreakpoints';
import {
  cleanItem,
  compareNames,
  deleteItems,
  dirtyItem,
  DirtyItem,
  GeneralItem,
  getItemName,
  GroupItem,
  Item,
  ItemNote,
  PersonItem,
  updateItems,
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

export interface Props extends BaseDrawerProps {
  item: DirtyItem<Item>,
  onChange: (item: DirtyItem<Item>) => void,
}

export interface ItemAndChangeCallback {
  item: Item,
  handleChange: <S extends Item>(data: Partial<Omit<S, 'type' | 'id'>>) => void,
}

interface ItemField {
  id: string,
  node: ReactNode,
  sizing?: Partial<Record<Breakpoint, boolean | GridSize>>,
}

function getValue(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
  return event.target.value;
}

function getFields(
  { item, handleChange }: ItemAndChangeCallback,
): ItemField[] {
  const fields: ItemField[] = [];

  if (item.type === 'person') {
    fields.push(
      {
        id: 'firstName',
        node: (
          <TextField
            autoFocus
            fullWidth
            key={item.id}
            label="First Name"
            onChange={event => handleChange<PersonItem>({ firstName: getValue(event) })}
            required
            value={item.firstName}
          />
        ),
        sizing: { sm: 6 },
      },
      {
        id: 'lastName',
        node: (
          <TextField
            fullWidth
            label="Last Name"
            onChange={event => handleChange<PersonItem>({ lastName: getValue(event) })}
            required
            value={item.lastName}
          />
        ),
        sizing: { sm: 6 },
      },
      {
        id: 'email',
        node: (
          <TextField
            fullWidth
            label="Email"
            onChange={event => handleChange<PersonItem>({ email: getValue(event) })}
            value={item.email}
          />
        ),
        sizing: { sm: 6 },
      },
      {
        id: 'phone',
        node: (
          <TextField
            fullWidth
            label="Phone"
            onChange={event => handleChange<PersonItem>({ phone: getValue(event) })}
            value={item.phone}
          />
        ),
        sizing: { sm: 6 },
      },
    );
  } else {
    fields.push(
      {
        id: 'name',
        node: (
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
        ),
      },
    );
  }

  fields.push(
    {
      id: 'description',
      node: (
        <TextField
          value={item.description}
          onChange={event => handleChange({ description: getValue(event) })}
          label="Description"
          fullWidth
        />
      ),
    },
    {
      id: 'summary',
      node: (
        <TextField
          value={item.summary}
          onChange={event => handleChange({ summary: getValue(event) })}
          label="Notes"
          multiline
          fullWidth
        />
      ),
    },
    {
      id: 'archived',
      node: (
        <FormControlLabel
          control={(
            <Checkbox
              checked={item.archived}
              onChange={(_, archived) => handleChange({ archived })}
            />
          )}
          label="Archived"
        />
      ),
    },
    {
      id: 'tags',
      node: (
        <TagSelection
          selectedTags={item.tags}
          onChange={tags => handleChange({ tags })}
        />
      ),
    },
  );

  // Default sizing to always full width
  return fields.map(
    f => ({
      ...f,
      sizing: { xs: 12, ...f.sizing },
    }),
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
  const vault = useVault();
  const groups = useItems<GroupItem>('group');
  const prevItem = usePrevious(item);

  const memberGroups = useMemo(
    () => (
      item.type === 'person'
        ? groups.filter(g => g.members.includes(item.id)).sort(compareNames)
        : []
    ),
    [item.id, item.type, groups],
  );

  const handleChange = useCallback(
    (data: Partial<Omit<Item, 'type' | 'id'>>) => (
      onChange(dirtyItem({ ...item, ...data }))
    ),
    [item, onChange],
  );

  const fields = useMemo(
    () => getFields({ item, handleChange }),
    [item, handleChange],
  );
  const sections = useMemo(
    () => getSections({ item, handleChange }),
    [item, handleChange],
  );

  const valid = !!getItemName(item).trim();

  const removeFromAllGroups = useCallback(
    () => {
      const updatedGroupItems: GroupItem[] = [];
      for (const group of memberGroups) {
        const newGroup: GroupItem = {
          ...group,
          members: group.members.filter(m => m !== item.id),
        };
        vault?.store(newGroup);
        updatedGroupItems.push(newGroup);
      }
      dispatch(updateItems(updatedGroupItems));
    },
    [dispatch, item.id, memberGroups, vault],
  );

  const handleSave = useCallback(
    async (itemToSave: DirtyItem<Item>) => {
      if ((itemToSave.dirty || itemToSave.isNew) && getItemName(itemToSave)) {
        const clean = cleanItem(itemToSave);
        vault?.store(clean);
        dispatch(updateItems([clean]));
      }
    },
    [dispatch, vault],
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
      dispatch(deleteItems([item]));
      onClose();
    },
    [dispatch, onClose, item, removeFromAllGroups, vault],
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
        canSave: valid,
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

        {fields.map(field => (
          <Grid item key={field.id} {...field.sizing}>
            {field.node}
          </Grid>
        ))}

        <CollapsibleSections sections={sections} />
      </Grid>
    </BaseDrawer>
  );
}

export default ItemDrawer;
