import React, {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Checkbox,
  Container,
  Divider,
  fade,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  TextField,
  Typography,
} from '@material-ui/core';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import SaveIcon from '@material-ui/icons/Check';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import {
  getBlankNote,
  getItemById,
  Item,
  ItemNote,
  updateItems,
} from '../../state/items';
import { useItems, useNoteMap, useVault } from '../../state/selectors';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemSearch from '../ItemSearch';
import ConfirmationDialog from '../ConfirmationDialog';
import { useAppDispatch } from '../../store';


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
  interaction: ItemNote<'interaction'> | undefined,
}


function InteractionDrawer({
  interaction: rawInteraction,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();
  const items = useItems();
  const noteMap = useNoteMap();

  const [interaction, setInteraction] = useState(getBlankNote('interaction'));
  const [linkedItem, setLinkedItem] = useState<Item>();
  const [showSensitive, setShowSensitive] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(
    () => {
      if (rawInteraction) {
        setInteraction(rawInteraction);
        const existingLinkedItem = getItemById(items, noteMap[rawInteraction.id]);
        setLinkedItem(existingLinkedItem);
        setShowSensitive(false);
      }
    },
    [items, noteMap, rawInteraction],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setInteraction({ ...interaction, content: value });
    },
    [interaction],
  );
  const handleChangePerson = useCallback(
    (item?: Item) => {
      setLinkedItem(item);
    },
    [],
  );
  const handleChangeSensitive = useCallback(
    () => setInteraction({ ...interaction, sensitive: !interaction.sensitive }),
    [interaction],
  );

  const handleClickVisibility = useCallback(() => setShowSensitive(show => !show), []);
  const handleMouseDownVisibility = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
    [],
  );

  const handleSave = useCallback(
    async () => {
      const newNote: ItemNote<'interaction'> = {
        ...interaction,
        content: interaction.content.trim(),
      };
      if (newNote.content && linkedItem) {
        const itemsToUpdate: Item[] = [];
        const oldItem = getItemById(items, noteMap[interaction.id]);
        if (oldItem && oldItem.id !== linkedItem.id) {
          itemsToUpdate.push({
            ...oldItem,
            notes: oldItem.notes.filter(note => note.id !== interaction.id),
          });
        }

        itemsToUpdate.push({
          ...linkedItem,
          notes: [
            ...linkedItem.notes.filter(note => note.id !== interaction.id),
            newNote,
          ],
        });

        for (const item of itemsToUpdate) {
          vault?.store(item);
        }
        dispatch(updateItems(itemsToUpdate));
        setInteraction(getBlankNote('interaction'));
      }
      onClose();
    },
    [dispatch, interaction, items, linkedItem, noteMap, onClose, vault],
  );
  const handleDelete = useCallback(
    () => {
      if (rawInteraction) {
        setShowConfirm(true);
      } else {
        setInteraction(getBlankNote('interaction'));
        onClose();
      }
    },
    [onClose, rawInteraction],
  );
  const handleConfirmDelete = useCallback(
    () => {
      if (rawInteraction) {
        const oldItem = getItemById(items, noteMap[rawInteraction.id]);
        if (oldItem) {
          const newItem: Item = {
            ...oldItem,
            notes: oldItem.notes.filter(note => note.id !== rawInteraction.id),
          };
          vault?.store(newItem);
          dispatch(updateItems([newItem]));
        }
      }
      setShowConfirm(false);
      setInteraction(getBlankNote('interaction'));
      onClose();
    },
    [dispatch, items, noteMap, onClose, rawInteraction, vault],
  );
  const handleConfirmCancel = useCallback(() => setShowConfirm(false), []);

  const isVisible = useMemo(
    () => !interaction.sensitive || showSensitive,
    [interaction, showSensitive],
  );

  return (
    <>
      <BaseDrawer
        open={open}
        onClose={handleSave}
        stacked={stacked}
      >
        <Container className={classes.drawerContainer}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <ItemSearch
                selectedIds={linkedItem ? [linkedItem.id] : []}
                items={items}
                label="Object of Interaction"
                onSelect={handleChangePerson}
              />
            </Grid>

            <Grid item xs={12}>
              <TextField
                value={!isVisible ? '...' : interaction.content}
                onChange={handleChange}
                disabled={!isVisible}
                label="Interaction details"
                multiline
                fullWidth
                InputProps={{
                  endAdornment: interaction.sensitive ? (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={handleClickVisibility}
                        onMouseDown={handleMouseDownVisibility}
                      >
                        {showSensitive ? <Visibility /> : <VisibilityOff />}
                      </IconButton>
                    </InputAdornment>
                  ) : null,
                }}
              />
            </Grid>

            <Grid item xs={12}>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={interaction.sensitive || false}
                    onChange={handleChangeSensitive}
                  />
                )}
                label="Sensitive"
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
                className={rawInteraction ? classes.danger : undefined}
                startIcon={rawInteraction ? <DeleteIcon /> : undefined}
              >
                {rawInteraction ? 'Delete' : 'Cancel'}
              </Button>
            </Grid>

            <Grid item xs={12} sm={6}>
              <Button
                color="primary"
                onClick={handleSave}
                variant="contained"
                fullWidth
                disabled={!interaction.content}
                startIcon={<SaveIcon />}
              >
                Done
              </Button>
            </Grid>
          </Grid>
        </Container>
      </BaseDrawer>

      <ConfirmationDialog
        open={showConfirm}
        onConfirm={handleConfirmDelete}
        onCancel={handleConfirmCancel}
      >
        <Typography paragraph>
          Are you sure you want to delete this interaction?
        </Typography>

        <Typography paragraph>
          This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  );
}

export default InteractionDrawer;
