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
  deleteItems,
  getBlankGroup,
  getItemName,
  GroupItem,
  ItemNote,
  PersonItem,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import MemberDisplay from '../MemberDisplay';
import { useVault } from '../../state/selectors';
import PersonDrawer from './Person';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ReportDrawer from './ReportDrawer';
import { Frequency } from '../../utils/frequencies';
import FrequencyControls from '../FrequencyControls';
import TagSelection from '../TagSelection';
import CollapsibleSections from './utils/CollapsibleSections';
import NoteControl from '../NoteControl';
import { getPrayerPoints } from '../../utils/prayer';
import { GroupsIcon } from '../Icons';
import LargeIcon from '../LargeIcon';

export interface Props extends ItemDrawerProps {
  item: GroupItem | undefined,
}


function GroupDrawer({
  alwaysTemporary,
  item: group,
  onBack,
  onClose,
  open,
  placeholder,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localGroup, setLocalGroup] = useState(group || getBlankGroup());
  const [showReport, setShowReport] = useState(false);
  const [showPerson, setShowPerson] = useState(false);
  const [currentPerson, setCurrentPerson] = useState<PersonItem>();

  const valid = !!localGroup.name;

  useEffect(
    () => {
      if (open) {
        if (group) {
          setLocalGroup({ ...group });
        } else {
          setLocalGroup(getBlankGroup());
        }
      }
    },
    [group, open],
  );

  const handleChange = useCallback(
    (key: keyof GroupItem) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setLocalGroup(g => ({ ...g, [key]: value }));
      }
    ),
    [],
  );
  const handleChangeBoolean = useCallback(
    (key: keyof GroupItem) => (
      (event: ChangeEvent<HTMLInputElement>, checked: boolean) => {
        setLocalGroup(g => ({ ...g, [key]: checked }));
      }
    ),
    [],
  );
  const handleChangeFrequency = useCallback(
    (key: 'interactionFrequency' | 'prayerFrequency') => (
      (value: Frequency) => {
        setLocalGroup(g => ({ ...g, [key as string]: value }));
      }
    ),
    [],
  );
  const handleChangeMembers = useCallback(
    (newMembers: string[]) => setLocalGroup(g => ({ ...g, members: newMembers })),
    [],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalGroup(g => ({ ...g, notes: newNotes })),
    [],
  );
  const handleChangeTags = useCallback(
    (newTags: string[]) => setLocalGroup(p => ({ ...p, tags: newTags })),
    [],
  );
  const handleClickPerson = useCallback(
    (person: PersonItem) => {
      setCurrentPerson(person);
      setShowPerson(true);
    },
    [],
  );
  const handleReport = useCallback(() => setShowReport(true), []);
  const handleSave = useCallback(
    async () => {
      localGroup.name = localGroup.name.trim();
      if (valid) {
        vault?.store(localGroup);
        dispatch(updateItems([localGroup]));
        setLocalGroup(getBlankGroup());
      }
      onClose();
    },
    [dispatch, localGroup, onClose, valid, vault],
  );
  const handleCancel = useCallback(
    () => {
      setLocalGroup(getBlankGroup());
      onClose();
    },
    [onClose],
  );
  const handleDelete = useCallback(
    () => {
      vault?.delete(localGroup.id);
      dispatch(deleteItems([localGroup]));
      setLocalGroup(getBlankGroup());
      onClose();
    },
    [dispatch, onClose, localGroup, vault],
  );
  const handleCloseReport = useCallback(() => setShowReport(false), []);
  const handleClosePersonDrawer = useCallback(() => setShowPerson(false), []);

  const prayerPoints = useMemo(() => getPrayerPoints(localGroup), [localGroup]);

  return (
    <>
      <BaseDrawer
        ActionProps={{
          canSave: valid,
          editing: !!group,
          itemName: group ? getItemName(group) : undefined,
          onCancel: handleCancel,
          onDelete: handleDelete,
          onReport: handleReport,
          onSave: handleSave,
        }}
        alwaysTemporary={alwaysTemporary}
        onBack={onBack}
        onClose={handleSave}
        open={open}
        placeholder={placeholder || (
          <>
            <LargeIcon icon={GroupsIcon} />

            <Typography variant="h5" color="textSecondary" align="center">
              Select a group from the list<br />
              or click the + to add a new group
            </Typography>
          </>
        )}
        stacked={stacked && !showPerson}
      >
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="h5">
              Basic details
            </Typography>
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localGroup.name}
              onChange={handleChange('name')}
              label="Group Name"
              required
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localGroup.description}
              onChange={handleChange('description')}
              label="Description"
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localGroup.summary}
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
                  checked={localGroup.archived}
                  onChange={handleChangeBoolean('archived')}
                />
              )}
              label="Archive"
            />
          </Grid>

          <Grid item xs={12}>
            <TagSelection
              selectedTags={localGroup.tags}
              onChange={handleChangeTags}
            />
          </Grid>

          <CollapsibleSections
            sections={[
              {
                id: 'frequencies',
                title: 'Prayer frequency',
                content: (
                  <FrequencyControls
                    item={localGroup}
                    noInteractions
                    onChange={handleChangeFrequency}
                  />
                ),
              },
              {
                id: 'member-display',
                title: 'Group members',
                content: (
                  <MemberDisplay
                    members={localGroup.members}
                    onChange={handleChangeMembers}
                    onClickMember={!stacked ? handleClickPerson : undefined}
                  />
                ),
              },
              {
                id: 'prayer-points',
                title: 'Prayer points',
                content: (
                  <NoteControl
                    noNotesText="No prayer points"
                    notes={prayerPoints}
                    onChange={handleChangeNotes}
                    noteType="prayer"
                  />
                ),
              },
            ]}
          />
        </Grid>
      </BaseDrawer>

      <ReportDrawer
        item={localGroup}
        onClose={handleCloseReport}
        open={showReport}
        placeholderIcon={GroupsIcon}
        stacked
      />

      {showPerson && (
        <PersonDrawer
          onClose={handleClosePersonDrawer}
          open={showPerson}
          item={currentPerson}
          stacked
        />
      )}
    </>
  );
}

export default GroupDrawer;
