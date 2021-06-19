import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Container,
  Grid,
  TextField,
} from '@material-ui/core';
import {
  compareNames,
  deleteItems,
  getBlankPerson,
  GroupItem,
  ItemNote,
  PersonItem,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteDisplay from '../NoteDisplay';
import { useItems, useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import GroupDrawer from './Group';
import GroupDisplay from '../GroupDisplay';
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
}));

export interface Props extends ItemDrawerProps {
  item: PersonItem | undefined,
}


function PersonDrawer({
  onClose,
  open,
  item: person,
  stacked,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();
  const groups = useItems<GroupItem>('group');

  const [localPerson, setLocalPerson] = useState(getBlankPerson());
  const [showGroup, setShowGroup] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<GroupItem>();

  useEffect(
    () => {
      if (person) {
        setLocalPerson({ ...person });
      } else {
        setLocalPerson(getBlankPerson());
      }
    },
    [person],
  );

  const memberGroupIds = useMemo(
    () => {
      const memberGroups = groups.filter(g => g.members.includes(localPerson.id));
      memberGroups.sort(compareNames);
      return memberGroups.map(g => g.id);
    },
    [groups, localPerson],
  );

  const handleChange = useCallback(
    (key: keyof PersonItem) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setLocalPerson({ ...localPerson, [key]: value });
      }
    ),
    [localPerson],
  );
  const handleChangeNotes = useCallback(
    (newNotes: ItemNote[]) => setLocalPerson({ ...localPerson, notes: newNotes }),
    [localPerson],
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
    [dispatch, localPerson, vault],
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
    [dispatch, localPerson, vault],
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
      vault?.delete(localPerson.id);
      dispatch(deleteItems([localPerson]));
      setLocalPerson(getBlankPerson());
      onClose();
    },
    [dispatch, onClose, localPerson, vault],
  );
  const handleCloseGroupDrawer = useCallback(() => setShowGroup(false), []);

  return (
    <>
      <BaseDrawer
        open={open}
        onClose={handleSave}
        stacked={stacked && !showGroup}
      >
        <Container className={classes.drawerContainer}>
          <Grid container spacing={2}>
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
                multiline
                fullWidth
              />
            </Grid>

            <Grid item />

            <Grid item xs={12}>
              <GroupDisplay
                groups={memberGroupIds}
                onAdd={handleAddGroup}
                onClickGroup={!stacked ? handleClickGroup : undefined}
                onRemove={handleRemoveGroup}
              />
            </Grid>

            <Grid item xs={12}>
              <NoteDisplay
                notes={localPerson.notes}
                onChange={handleChangeNotes}
              />
            </Grid>
          </Grid>

          <div className={classes.filler} />

          <DrawerActions
            canSave={valid}
            item={person}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onSave={handleSave}
          />
        </Container>
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
