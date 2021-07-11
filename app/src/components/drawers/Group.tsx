import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
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
import NoteControl from '../NoteControl';
import MemberDisplay from '../MemberDisplay';
import { useVault } from '../../state/selectors';
import PersonDrawer from './Person';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ReportDrawer from './ReportDrawer';
import { Frequency } from '../../utils/frequencies';
import FrequencyControls from '../FrequencyControls';
import TagSelection from '../TagSelection';

export interface Props extends ItemDrawerProps {
  item: GroupItem | undefined,
}


function GroupDrawer({
  item: group,
  onBack,
  onClose,
  open,
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
      if (group) {
        setLocalGroup({ ...group });
      } else {
        setLocalGroup(getBlankGroup());
      }
    },
    [group],
  );

  const handleChange = useCallback(
    (key: keyof GroupItem) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setLocalGroup({ ...localGroup, [key]: value });
      }
    ),
    [localGroup],
  );
  const handleChangeFrequency = useCallback(
    (key: 'interactionFrequency' | 'prayerFrequency') => (
      (value: Frequency) => {
        setLocalGroup({ ...localGroup, [key as string]: value });
      }
    ),
    [localGroup],
  );
  const handleChangeMembers = useCallback(
    (newMembers: string[]) => setLocalGroup({ ...localGroup, members: newMembers }),
    [localGroup],
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
        open={open}
        onBack={onBack}
        onClose={handleSave}
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
            <TagSelection
              selectedTags={localGroup.tags}
              onChange={handleChangeTags}
            />
          </Grid>

          <Grid item />
          <Grid item xs={12}>
            <Typography variant="h5">
              Desired frequency
            </Typography>
          </Grid>

          <FrequencyControls
            item={localGroup}
            noInteractions
            onChange={handleChangeFrequency}
          />

          <Grid item />
          <Grid item xs={12}>
            <Typography variant="h5">
              Members
            </Typography>
          </Grid>

          <Grid item xs={12}>
            <MemberDisplay
              members={localGroup.members}
              onChange={handleChangeMembers}
              onClickMember={!stacked ? handleClickPerson : undefined}
            />
          </Grid>

          <Grid item />
          <Grid item xs={12}>
            <Typography variant="h5">
              Notes
            </Typography>
          </Grid>

          <Grid item xs={12}>
            <NoteControl
              excludeTypes={['interaction']}
              notes={localGroup.notes}
              onChange={handleChangeNotes}
            />
          </Grid>
        </Grid>
      </BaseDrawer>

      <ReportDrawer
        item={localGroup}
        onClose={handleCloseReport}
        open={showReport}
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
