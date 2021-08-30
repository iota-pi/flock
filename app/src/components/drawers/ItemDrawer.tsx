import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Checkbox,
  Collapse,
  FormControlLabel,
  Grid,
  makeStyles,
  styled,
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
import GroupDisplay from '../GroupDisplay';
import MemberDisplay from '../MemberDisplay';
import { pushActive } from '../../state/ui';
import { usePrevious } from '../../utils';
import { ActionIcon, GroupIcon, InteractionIcon, PersonIcon, PrayerIcon } from '../Icons';
import MaturityPicker from '../MaturityPicker';
import { getLastPrayedFor } from '../../utils/prayer';
import { getLastInteractionDate } from '../../utils/interactions';
import CollapsibleSection from './utils/CollapsibleSection';

const useStyles = makeStyles(theme => ({
  alert: {
    transition: theme.transitions.create('all'),
  },
  emphasis: {
    fontWeight: 500,
  },
}));

const SectionHolder = styled('div')({
  flexGrow: 1,
});

export interface Props extends BaseDrawerProps {
  item: DirtyItem<Item>,
  onChange: (item: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>>) => void,
}

export interface ItemAndChangeCallback {
  item: Item,
  handleChange: <S extends Item>(data: Partial<Omit<S, 'type' | 'id'>>) => void,
}

function DuplicateAlert({ item, count }: { item: Item, count: number }) {
  const classes = useStyles();
  const ref = useRef<number>(1);
  useEffect(() => {
    if (count > 0) {
      ref.current = count;
    }
  });
  const displayCount = count || ref.current;

  const plural = displayCount !== 1;
  const areOrIs = plural ? 'are' : 'is';

  return (
    <Alert
      className={classes.alert}
      severity={item.description ? 'info' : 'warning'}
    >
      <Typography paragraph={!item.description}>
        There {areOrIs} <span className={classes.emphasis}>{displayCount}</span>
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

  const [cancelled, setCancelled] = useState(false);
  const [duplicates, setDuplicates] = useState<Item[]>([]);

  const prevItem = usePrevious(item);

  const memberGroups = useMemo(
    () => (
      item.type === 'person'
        ? groups.filter(g => g.members.includes(item.id)).sort(compareNames)
        : []
    ),
    [item.id, item.type, groups],
  );

  const itemsByName = useMemo(
    () => {
      const result: { [name: string]: Item[] | undefined } = {};
      for (const i of items) {
        const name = getItemName(i);
        if (result[name] === undefined) {
          result[name] = [i];
        } else {
          result[name]!.push(i);
        }
      }
      return result;
    },
    [items],
  );

  useEffect(
    () => {
      const potential = itemsByName[getItemName(item)];
      if (potential) {
        setDuplicates(
          potential.filter(i => i.type === item.type && i.id !== item.id),
        );
      } else {
        setDuplicates([]);
      }
    },
    [item, itemsByName],
  );

  const handleChange = useCallback(
    <S extends Item>(data: Partial<Omit<S, 'type' | 'id'>>) => (
      onChange(dirtyItem({ ...data }))
    ),
    [onChange],
  );
  const handleChangeMaturity = useCallback(
    (maturity: string | null) => handleChange<PersonItem>({ maturity }),
    [handleChange],
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
    (itemToSave: DirtyItem<Item>) => {
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
  const handleCancel = useCallback(() => setCancelled(true), []);
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
    () => dispatch(pushActive({ item: item.id, report: true })),
    [dispatch, item],
  );

  const handleUnmount = useCallback(
    () => {
      if (!cancelled) {
        handleSave(item);
      }
    },
    [cancelled, handleSave, item],
  );

  useEffect(
    () => {
      if (cancelled) onClose();
    },
    [cancelled, onClose],
  );
  useEffect(
    () => {
      if (open && prevItem && prevItem.id !== item.id) {
        handleSave(prevItem);
      }
    },
    [handleSave, item.id, open, prevItem],
  );

  const firstName = item.type === 'person' ? item.firstName : item.name;
  const lastName = item.type === 'person' ? item.lastName : undefined;
  const nameFields = useMemo(
    () => (
      lastName !== undefined ? (
        <>
          <Grid item xs={6}>
            <TextField
              autoFocus
              data-cy="firstName"
              fullWidth
              key={item.id}
              label="First Name"
              onChange={event => handleChange<PersonItem>({ firstName: getValue(event) })}
              required
              value={firstName}
            />
          </Grid>

          <Grid item xs={6}>
            <TextField
              fullWidth
              data-cy="lastName"
              label="Last Name"
              onChange={event => handleChange<PersonItem>({ lastName: getValue(event) })}
              value={lastName}
            />
          </Grid>
        </>
      ) : (
        <Grid item xs={12}>
          <TextField
            autoFocus
            data-cy="name"
            fullWidth
            key={item.id}
            label="Name"
            onChange={
              event => handleChange<GeneralItem | GroupItem>({ name: getValue(event) })
            }
            required
            value={firstName}
          />
        </Grid>
      )
    ),
    [firstName, handleChange, item.id, lastName],
  );

  const email = item.type === 'person' ? item.email : undefined;
  const emailField = useMemo(
    () => (
      email !== undefined ? (
        <Grid item xs={6}>
          <TextField
            data-cy="email"
            fullWidth
            label="Email"
            onChange={event => handleChange<PersonItem>({ email: getValue(event) })}
            value={email}
          />
        </Grid>
      ) : null
    ),
    [email, handleChange],
  );

  const phone = item.type === 'person' ? item.phone : undefined;
  const phoneField = useMemo(
    () => (
      phone !== undefined ? (
        <Grid item xs={6}>
          <TextField
            data-cy="phone"
            fullWidth
            label="Phone"
            onChange={event => handleChange<PersonItem>({ phone: getValue(event) })}
            value={phone}
          />
        </Grid>
      ) : null
    ),
    [handleChange, phone],
  );

  const { archived, tags } = item;
  const descriptionField = useMemo(
    () => (
      <Grid item xs={12}>
        <TextField
          data-cy="description"
          fullWidth
          label="Description"
          onChange={event => handleChange({ description: getValue(event) })}
          value={item.description}
        />
      </Grid>
    ),
    [handleChange, item.description],
  );
  const summaryField = useMemo(
    () => (
      <Grid item xs={12}>
        <TextField
          data-cy="summary"
          fullWidth
          label="Notes"
          multiline
          onChange={event => handleChange({ summary: getValue(event) })}
          value={item.summary}
        />
      </Grid>
    ),
    [handleChange, item.summary],
  );
  const archivedField = useMemo(
    () => (
      <Grid item xs={12}>
        <FormControlLabel
          control={(
            <Checkbox
              checked={archived}
              data-cy="archived"
              onChange={(_, newArchived) => handleChange({ archived: newArchived })}
            />
          )}
          label="Archived"
        />
      </Grid>
    ),
    [archived, handleChange],
  );
  const tagsField = useMemo(
    () => (
      <Grid item xs={12}>
        <TagSelection
          selectedTags={tags}
          onChange={newTags => handleChange({ tags: newTags })}
        />
      </Grid>
    ),
    [handleChange, tags],
  );

  const maturity = item.type === 'person' ? item.maturity : undefined;
  const maturityField = useMemo(
    () => (
      maturity !== undefined ? (
        <Grid item xs={12}>
          <MaturityPicker
            fullWidth
            maturity={maturity}
            onChange={handleChangeMaturity}
          />
        </Grid>
      ) : null
    ),
    [handleChangeMaturity, maturity],
  );

  const lastInteraction = item.type === 'person' ? getLastInteractionDate(item) : 0;
  const lastPrayer = getLastPrayedFor(item);
  const frequencyField = useMemo(
    () => (
      <Grid item xs={12}>
        <FrequencyControls
          interactionFrequency={item.interactionFrequency}
          lastInteraction={lastInteraction}
          lastPrayer={lastPrayer}
          noInteractions={item.type !== 'person'}
          onChange={handleChange}
          prayerFrequency={item.prayerFrequency}
        />
      </Grid>
    ),
    [
      handleChange,
      item.interactionFrequency,
      item.prayerFrequency,
      item.type,
      lastInteraction,
      lastPrayer,
    ],
  );

  const groupsSection = useMemo(
    () => item.type === 'person' && (
      <CollapsibleSection
        content={<GroupDisplay itemId={item.id} />}
        icon={GroupIcon}
        id="groups"
        initialExpanded={item.isNew}
        title="Groups"
      />
    ),
    [item.id, item.isNew, item.type],
  );

  const members = item.type === 'group' ? item.members : undefined;
  const membersSection = useMemo(
    () => members !== undefined && (
      <CollapsibleSection
        content={(
          <MemberDisplay
            memberIds={members}
            onChange={group => handleChange<GroupItem>(group)}
          />
        )}
        icon={PersonIcon}
        id="members"
        initialExpanded={item.isNew}
        title="Members"
      />
    ),
    [handleChange, item.isNew, members],
  );

  const prayerSection = useMemo(
    () => (
      <CollapsibleSection
        content={(
          <NoteControl
            noNotesText="No prayer points"
            notes={item.notes}
            onChange={(notes: ItemNote[]) => handleChange({ notes })}
            noteType="prayer"
          />
        )}
        icon={PrayerIcon}
        id="prayer-points"
        initialExpanded={item.isNew}
        title="Prayer points"
      />
    ),
    [handleChange, item.isNew, item.notes],
  );

  const interactionSection = useMemo(
    () => item.type === 'person' && (
      <CollapsibleSection
        content={(
          <NoteControl
            noNotesText="No interactions"
            notes={item.notes}
            onChange={(notes: ItemNote[]) => handleChange({ notes })}
            noteType="interaction"
          />
        )}
        icon={InteractionIcon}
        id="interactions"
        initialExpanded={item.isNew}
        title="Interactions"
      />
    ),
    [handleChange, item.isNew, item.notes, item.type],
  );

  const actionSection = useMemo(
    () => (
      <CollapsibleSection
        content={(
          <NoteControl
            noNotesText="No actions"
            notes={item.notes}
            onChange={(notes: ItemNote[]) => handleChange({ notes })}
            noteType="action"
          />
        )}
        icon={ActionIcon}
        id="actions"
        initialExpanded={item.isNew}
        title="Actions"
      />
    ),
    [handleChange, item.isNew, item.notes],
  );

  return (
    <BaseDrawer
      ActionProps={{
        canSave: isValid(item),
        itemIsNew: item.isNew,
        itemName: getItemName(item),
        onCancel: handleCancel,
        onDelete: handleDelete,
        onReport: hasReport ? handleReport : undefined,
        onSave: handleSaveAndClose,
      }}
      alwaysTemporary={alwaysTemporary}
      itemKey={item.id}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
    >
      <Grid container spacing={2}>
        <Collapse in={duplicates.length > 0}>
          <Grid item xs={12}>
            <DuplicateAlert item={item} count={duplicates.length} />
          </Grid>
        </Collapse>

        {nameFields}

        {emailField}
        {phoneField}

        {descriptionField}
        {summaryField}
        {archivedField}
        {tagsField}

        {maturityField}

        {frequencyField}

        <SectionHolder>
          {groupsSection}
          {membersSection}
          {prayerSection}
          {interactionSection}
          {actionSection}
        </SectionHolder>
      </Grid>
    </BaseDrawer>
  );
}

export default ItemDrawer;
