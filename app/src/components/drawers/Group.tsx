import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Container,
  fade,
  Grid,
  TextField,
} from '@material-ui/core';
import {
  deleteItems,
  getBlankGroup,
  GroupItem,
  ItemNote,
  PersonItem,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteDisplay from '../NoteDisplay';
import MemberDisplay from '../MemberDisplay';
import { useVault } from '../../state/selectors';
import PersonDrawer from './Person';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import GroupReportDrawer from './GroupReport';
import DrawerActions from '../DrawerActions';


const useStyles = makeStyles(theme => ({
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  filler: {
    flexGrow: 1,
  },
  danger: {
    borderColor: theme.palette.error.light,
    color: theme.palette.error.light,

    '&:hover': {
      backgroundColor: fade(theme.palette.error.light, 0.08),
    },
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props extends ItemDrawerProps {
  item: GroupItem | undefined,
}


function GroupDrawer({
  item: group,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localGroup, setLocalGroup] = useState(getBlankGroup());
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
  const handleChangeMembers = useCallback(
    (newMembers: string[]) => setLocalGroup({ ...localGroup, members: newMembers }),
    [localGroup],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalGroup({ ...localGroup, notes: newNotes }),
    [localGroup],
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
        open={open}
        onClose={handleSave}
        stacked={stacked && !showPerson}
      >
        <Container className={classes.drawerContainer}>
          <Grid container spacing={2}>
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
                multiline
                fullWidth
              />
            </Grid>

            <Grid item />

            <Grid item xs={12}>
              <MemberDisplay
                members={localGroup.members}
                onChange={handleChangeMembers}
                onClickMember={!stacked ? handleClickPerson : undefined}
              />
            </Grid>

            <Grid item xs={12}>
              <NoteDisplay
                notes={localGroup.notes}
                onChange={handleChangeNotes}
              />
            </Grid>
          </Grid>

          <div className={classes.filler} />

          <DrawerActions
            canSave={valid}
            item={group}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onReport={handleReport}
            onSave={handleSave}
          />
        </Container>
      </BaseDrawer>

      <GroupReportDrawer
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
