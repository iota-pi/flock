import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Checkbox,
  FormControlLabel,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import {
  compareNames,
  deleteItems,
  getBlankPerson,
  getItemName,
  GroupItem,
  ItemNote,
  PersonItem,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteControl from '../NoteControl';
import { useItems, useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import GroupDrawer from './Group';
import GroupDisplay from '../GroupDisplay';
import { Frequency } from '../../utils/frequencies';
import FrequencyControls from '../FrequencyControls';
import TagSelection from '../TagSelection';
import CollapsibleSections from './utils/CollapsibleSections';
import { getInteractions } from '../../utils/interactions';
import { getPrayerPoints } from '../../utils/prayer';
import { PersonIcon } from '../Icons';
import LargeIcon from '../LargeIcon';

export interface Props extends ItemDrawerProps {
  item: PersonItem | undefined,
}


function PersonDrawer({
  alwaysTemporary,
  item: person,
  onBack,
  onClose,
  open,
  placeholder,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const vault = useVault();
  const groups = useItems<GroupItem>('group');

  const [localPerson, setLocalPerson] = useState(person || getBlankPerson());
  const [showGroup, setShowGroup] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<GroupItem>();

  useEffect(
    () => {
      if (open) {
        if (person) {
          setLocalPerson({ ...person });
        } else {
          setLocalPerson(getBlankPerson());
        }
      }
    },
    [open, person],
  );

  const memberGroups = useMemo(
    () => groups.filter(g => g.members.includes(localPerson.id)).sort(compareNames),
    [groups, localPerson.id],
  );
  const memberGroupIds = useMemo(
    () => memberGroups.map(g => g.id),
    [memberGroups],
  );

  const handleChange = useCallback(
    (key: keyof PersonItem) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setLocalPerson(p => ({ ...p, [key]: value }));
      }
    ),
    [],
  );
  const handleChangeBoolean = useCallback(
    (key: keyof PersonItem) => (
      (event: ChangeEvent<HTMLInputElement>, checked: boolean) => {
        setLocalPerson(p => ({ ...p, [key]: checked }));
      }
    ),
    [],
  );
  const handleChangeFrequency = useCallback(
    (key: 'interactionFrequency' | 'prayerFrequency') => (
      (value: Frequency) => {
        setLocalPerson(p => ({ ...p, [key as string]: value }));
      }
    ),
    [],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalPerson(p => ({ ...p, notes: newNotes })),
    [],
  );
  const handleChangeTags = useCallback(
    (newTags: string[]) => setLocalPerson(p => ({ ...p, tags: newTags })),
    [],
  );
  const handleAddGroup = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: [...group.members, localPerson.id],
      };
      vault?.store(newGroup);
      dispatch(updateItems([newGroup]));
    },
    [dispatch, localPerson.id, vault],
  );
  const handleClickGroup = useCallback(
    (group: GroupItem) => {
      setCurrentGroup(group);
      setShowGroup(true);
    },
    [],
  );
  const handleRemoveGroup = useCallback(
    (group: GroupItem) => {
      const newGroup: GroupItem = {
        ...group,
        members: group.members.filter(m => m !== localPerson.id),
      };
      vault?.store(newGroup);
      dispatch(updateItems([newGroup]));
    },
    [dispatch, localPerson.id, vault],
  );
  const removeFromAllGroups = useCallback(
    () => {
      const updatedGroupItems: GroupItem[] = [];
      for (const group of memberGroups) {
        const newGroup: GroupItem = {
          ...group,
          members: group.members.filter(m => m !== localPerson.id),
        };
        vault?.store(newGroup);
        updatedGroupItems.push(newGroup);
      }
      dispatch(updateItems(updatedGroupItems));
    },
    [dispatch, localPerson.id, memberGroups, vault],
  );

  const valid = !!localPerson.firstName && !!localPerson.lastName;

  const handleSave = useCallback(
    async () => {
      localPerson.firstName = localPerson.firstName.trim();
      localPerson.lastName = localPerson.lastName.trim();
      localPerson.email = localPerson.email.trim();
      localPerson.phone = localPerson.phone.trim();
      if (valid) {
        vault?.store(localPerson);
        dispatch(updateItems([localPerson]));
        setLocalPerson(getBlankPerson());
      }
      onClose();
    },
    [dispatch, localPerson, onClose, valid, vault],
  );
  const handleCancel = useCallback(
    () => {
      setLocalPerson(getBlankPerson());
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      removeFromAllGroups();
      vault?.delete(localPerson.id);
      dispatch(deleteItems([localPerson]));
      setLocalPerson(getBlankPerson());
      onClose();
    },
    [dispatch, onClose, localPerson, removeFromAllGroups, vault],
  );
  const handleCloseGroupDrawer = useCallback(() => setShowGroup(false), []);

  const prayerPoints = useMemo(() => getPrayerPoints(localPerson), [localPerson]);
  const interactions = useMemo(() => getInteractions(localPerson), [localPerson]);

  return (
    <>
      <BaseDrawer
        ActionProps={{
          canSave: valid,
          editing: !!person,
          itemName: person ? getItemName(person) : undefined,
          onCancel: handleCancel,
          onDelete: handleDelete,
          onSave: handleSave,
        }}
        alwaysTemporary={alwaysTemporary}
        onBack={onBack}
        onClose={handleSave}
        open={open}
        placeholder={placeholder || (
          <>
            <LargeIcon icon={PersonIcon} />

            <Typography variant="h5" color="textSecondary" align="center">
              Select a person from the list<br />
              or click the + to add a new person
            </Typography>
          </>
        )}
        stacked={stacked && !showGroup}
      >
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="h5">
              Basic details
            </Typography>
          </Grid>

          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.firstName}
              onChange={handleChange('firstName')}
              label="First Name"
              required
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.lastName}
              onChange={handleChange('lastName')}
              label="Last Name"
              required
              fullWidth
            />
          </Grid>

          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.email}
              onChange={handleChange('email')}
              label="Email"
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.phone}
              onChange={handleChange('phone')}
              label="Phone"
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localPerson.description}
              onChange={handleChange('description')}
              label="Description"
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localPerson.summary}
              onChange={handleChange('summary')}
              label="Notes"
              multiline
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={localPerson.archived}
                  onChange={handleChangeBoolean('archived')}
                />
              )}
              label="Archive"
            />
          </Grid>

          <Grid item xs={12}>
            <TagSelection
              selectedTags={localPerson.tags}
              onChange={handleChangeTags}
            />
          </Grid>

          <CollapsibleSections
            sections={[
              {
                id: 'frequencies',
                title: 'Prayer and interaction frequencies',
                content: (
                  <FrequencyControls
                    item={localPerson}
                    onChange={handleChangeFrequency}
                  />
                ),
              },
              {
                id: 'group-display',
                title: 'Group membership',
                content: (
                  <GroupDisplay
                    groups={memberGroupIds}
                    onAdd={handleAddGroup}
                    onClickGroup={!stacked ? handleClickGroup : undefined}
                    onRemove={handleRemoveGroup}
                  />
                ),
              },
              {
                id: 'prayer-points',
                title: 'Prayer points',
                content: (
                  <NoteControl
                    notes={prayerPoints}
                    onChange={handleChangeNotes}
                    noteType="prayer"
                  />
                ),
              },
              {
                id: 'interactions',
                title: 'Interactions',
                content: (
                  <NoteControl
                    notes={interactions}
                    onChange={handleChangeNotes}
                    noteType="interaction"
                  />
                ),
              },
            ]}
          />
        </Grid>
      </BaseDrawer>

      {showGroup && (
        <GroupDrawer
          onClose={handleCloseGroupDrawer}
          open={showGroup}
          item={currentGroup}
          stacked
        />
      )}
    </>
  );
}

export default PersonDrawer;
