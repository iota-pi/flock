import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Container,
  Divider,
  Drawer,
  fade,
  Grid,
  TextField,
  Typography,
} from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import SaveIcon from '@material-ui/icons/Check';
import {
  deleteItems,
  getBlankGroup,
  getItemName,
  GroupItem,
  ItemNote,
  ItemNoteType,
  updateItems,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteDisplay from '../NoteDisplay';
import ConfirmationDialog from '../ConfirmationDialog';
import MemberDisplay from '../MemberDisplay';
import { useVault } from '../../state/selectors';


const useStyles = makeStyles(theme => ({
  drawer: {
    flexShrink: 0,

    width: '60%',
    [theme.breakpoints.only('sm')]: {
      width: '70%',
    },
    [theme.breakpoints.only('xs')]: {
      width: '100%',
    },
  },
  drawerPaper: {
    width: '60%',
    [theme.breakpoints.only('sm')]: {
      width: '70%',
    },
    [theme.breakpoints.only('xs')]: {
      width: '100%',
    },
  },
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

export interface Props {
  onClose: () => void,
  open: boolean,
  group: GroupItem | undefined,
}

const ALL_NOTE_TYPES = 'all';
export const noteFilterOptions: [ItemNoteType | typeof ALL_NOTE_TYPES, string][] = [
  [ALL_NOTE_TYPES, 'All Notes'],
  ['general', 'General Notes'],
  ['prayer', 'Prayer Points'],
  ['interaction', 'Interactions'],
];


function GroupDrawer({
  onClose,
  open,
  group,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localGroup, setLocalGroup] = useState(getBlankGroup());
  const [showConfirm, setShowConfirm] = useState(false);

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

  const valid = !!localGroup.name;

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
  const handleDelete = useCallback(
    () => {
      if (group) {
        setShowConfirm(true);
      } else {
        setLocalGroup(getBlankGroup());
        onClose();
      }
    },
    [onClose, group],
  );
  const handleConfirmedDelete = useCallback(
    () => {
      vault?.delete(localGroup.id);
      dispatch(deleteItems([localGroup]));
      setShowConfirm(false);
      setLocalGroup(getBlankGroup());
      onClose();
    },
    [dispatch, onClose, localGroup, vault],
  );
  const handleCancel = useCallback(() => setShowConfirm(false), []);

  return (
    <>
      <Drawer
        className={classes.drawer}
        variant="temporary"
        open={open}
        onClose={handleSave}
        anchor="right"
        classes={{
          paper: classes.drawerPaper,
        }}
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

          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Divider />
            </Grid>

            <Grid item xs={12} sm={6}>
              <Button
                onClick={handleDelete}
                variant="outlined"
                fullWidth
                className={group ? classes.danger : undefined}
                startIcon={group ? <DeleteIcon /> : undefined}
              >
                {group ? 'Delete' : 'Cancel'}
              </Button>
            </Grid>

            <Grid item xs={12} sm={6}>
              <Button
                color="primary"
                onClick={handleSave}
                variant="contained"
                fullWidth
                disabled={!valid}
                startIcon={<SaveIcon />}
              >
                Done
              </Button>
            </Grid>
          </Grid>
        </Container>
      </Drawer>

      <ConfirmationDialog
        open={showConfirm}
        onConfirm={handleConfirmedDelete}
        onCancel={handleCancel}
      >
        <Typography paragraph>
          Are you sure you want to delete
          {' '}
          <span className={classes.emphasis}>{getItemName(localGroup)}</span>
          , and all associated notes?
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  );
}

export default GroupDrawer;
