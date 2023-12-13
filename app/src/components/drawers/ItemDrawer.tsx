import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Button,
  Collapse,
  Grid,
  IconButton,
  TextField,
  Tooltip,
} from '@mui/material';
import {
  cleanItem,
  compareNames,
  convertItem,
  dirtyItem,
  DirtyItem,
  GeneralItem,
  getItemName,
  getItemTypeLabel,
  GroupItem,
  isValid,
  Item,
  ItemNote,
  ITEM_TYPES,
  PersonItem,
} from '../../state/items';
import { useAppDispatch } from '../../store';
import NoteControl from '../NoteControl';
import { useItems } from '../../state/selectors';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import FrequencyControls from '../FrequencyControls';
import TagSelection from '../TagSelection';
import GroupDisplay from '../GroupDisplay';
import MemberDisplay from '../MemberDisplay';
import CollapsibleSection from './utils/CollapsibleSection';
import DuplicateAlert from './utils/DuplicateAlert';
import { pushActive } from '../../state/ui';
import { usePrevious } from '../../utils';
import {
  ActionIcon,
  ArchiveIcon,
  getIcon,
  getIconType,
  GroupIcon,
  InteractionIcon,
  NotesIcon,
  PersonIcon,
  UnarchiveIcon,
} from '../Icons';
import MaturityPicker from '../MaturityPicker';
import { getLastPrayedFor } from '../../utils/prayer';
import { getLastInteractionDate } from '../../utils/interactions';
import { deleteItems, storeItems } from '../../api/Vault';


export interface Props extends BaseDrawerProps {
  item: DirtyItem<Item>,
  onChange: (
    item: DirtyItem<Partial<Omit<Item, 'type' | 'id'>>> | ((prev: Item) => Item),
  ) => void,
}

export interface ItemAndChangeCallback {
  item: Item,
  handleChange: <S extends Item>(data: Partial<Omit<S, 'type' | 'id'>>) => void,
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

  const [cancelled, setCancelled] = useState(false);
  const [duplicates, setDuplicates] = useState<Item[]>([]);
  const [forceShowDescription, setShowDescription] = useState(false);

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
      if (prevItem?.id !== item.id) {
        setShowDescription(!!item.description);
      }
    },
    [item.description, item.id, prevItem?.id],
  );
  const showDescription = forceShowDescription || !!item.description;

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

  const handleClickAddDescription = useCallback(() => setShowDescription(true), []);
  const handleChange = useCallback(
    <T extends Item>(data: Partial<Omit<T, 'type' | 'id'>> | ((prev: Item) => Item)) => {
      if (typeof data === 'function') {
        return onChange(originalItem => dirtyItem(data(originalItem)));
      }
      return onChange(dirtyItem({ ...data }));
    },
    [onChange],
  );
  const handleChangeMaturity = useCallback(
    (maturity: string | null) => handleChange<PersonItem>({ maturity }),
    [handleChange],
  );
  const handleChangeNotes = useCallback(
    (callback: (prevNotes: ItemNote[]) => ItemNote[]) => {
      onChange(i => dirtyItem({ ...i, notes: callback(i.notes) }));
    },
    [onChange],
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
      storeItems(updatedGroupItems);
    },
    [item.id, memberGroups],
  );

  const handleSave = useCallback(
    (itemToSave: DirtyItem<Item>) => {
      if ((itemToSave.dirty || itemToSave.isNew) && isValid(itemToSave)) {
        const clean = cleanItem(itemToSave);
        storeItems(clean);
        return clean;
      }
      return undefined;
    },
    [],
  );
  const handleSaveAndClose = useCallback(
    () => {
      handleSave(item);
      onClose();
    },
    [handleSave, item, onClose],
  );
  const handleSaveButton = useCallback(
    () => {
      const clean = handleSave(item);
      if (clean) {
        onChange(clean);
      }
    },
    [handleSave, item, onChange],
  );
  const handleCancel = useCallback(() => setCancelled(true), []);
  const handleDelete = useCallback(
    () => {
      removeFromAllGroups();
      deleteItems(item.id);
      onClose();
    },
    [onClose, item.id, removeFromAllGroups],
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
  useEffect(
    () => {
      if (item.dirty && !item.isNew) {
        const timeout = setTimeout(
          () => handleSave(item),
          10000,
        );
        return () => clearTimeout(timeout);
      }
      return undefined;
    },
    [handleSave, item],
  );

  const hasDescription = !!item.description;
  const duplicateAlert = useMemo(
    () => (
      <Grid item xs={12} mt={-1}>
        <Collapse in={duplicates.length > 0}>
          <DuplicateAlert
            count={duplicates.length}
            hasDescription={hasDescription}
            itemType={item.type}
          />
        </Collapse>
      </Grid>
    ),
    [duplicates, hasDescription, item.type],
  );

  const firstName = item.type === 'person' ? item.firstName : item.name;
  const lastName = item.type === 'person' ? item.lastName : undefined;
  const nameFields = useMemo(
    () => (
      lastName !== undefined ? (
        <>
          <Grid item xs={showDescription ? 6 : 5} lg={showDescription ? 3 : 6}>
            <TextField
              autoFocus
              data-cy="firstName"
              fullWidth
              key={item.id}
              label="First Name"
              onChange={event => handleChange<PersonItem>({ firstName: getValue(event) })}
              required
              value={firstName}
              variant="standard"
            />
          </Grid>

          <Grid item xs={showDescription ? 6 : 5} lg={showDescription ? 3 : 5}>
            <TextField
              fullWidth
              data-cy="lastName"
              label="Last Name"
              onChange={event => handleChange<PersonItem>({ lastName: getValue(event) })}
              value={lastName}
              variant="standard"
            />
          </Grid>
        </>
      ) : (
        <Grid item xs={showDescription ? 12 : 10} lg={showDescription ? 12 : 11}>
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
            variant="standard"
          />
        </Grid>
      )
    ),
    [firstName, handleChange, item.id, lastName, showDescription],
  );

  const { archived, tags } = item;
  const descriptionField = useMemo(
    () => (
      item.description || showDescription ? (
        <Grid item xs={12} lg={6}>
          <TextField
            data-cy="description"
            fullWidth
            label="Short Description"
            onChange={event => handleChange({ description: getValue(event) })}
            value={item.description}
            variant="standard"
          />
        </Grid>
      ) : (
        <Grid
          item
          xs={2}
          lg={1}
          display="flex"
          align-items="flex-end"
          justifyContent="flex-end"
        >
          <Tooltip title="Add description">
            <IconButton
              data-cy="add-description"
              onClick={handleClickAddDescription}
            >
              <NotesIcon />
            </IconButton>
          </Tooltip>
        </Grid>
      )
    ),
    [handleChange, handleClickAddDescription, item.description, showDescription],
  );
  const summaryField = useMemo(
    () => (
      <Grid item xs={12}>
        <TextField
          data-cy="summary"
          fullWidth
          label="Notes"
          multiline
          minRows={3}
          onChange={event => handleChange({ summary: getValue(event) })}
          value={item.summary}
          variant="outlined"
        />
      </Grid>
    ),
    [handleChange, item.summary],
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
            variant="outlined"
          />
        </Grid>
      ) : null
    ),
    [handleChangeMaturity, maturity],
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
            variant="standard"
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
            variant="standard"
          />
        </Grid>
      ) : null
    ),
    [handleChange, phone],
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

  const archivedButton = useMemo(
    () => (
      <Grid item xs={12}>
        <Button
          color="inherit"
          data-cy="archived"
          disabled={item.isNew}
          fullWidth
          onClick={() => handleChange({ archived: !archived })}
          size="large"
          startIcon={archived ? <UnarchiveIcon /> : <ArchiveIcon />}
          variant="outlined"
        >
          {archived ? 'Unarchive' : 'Archive'}
        </Button>
      </Grid>
    ),
    [archived, handleChange, item.isNew],
  );
  const changeTypeButtons = useMemo(
    () => ITEM_TYPES.filter(t => t !== item.type).map(itemType => (
      <Grid
        item
        key={itemType}
        xs={12 / (ITEM_TYPES.length - 1)}
      >
        <Button
          color="inherit"
          data-cy="change-type"
          fullWidth
          onClick={() => handleChange(i => convertItem(i, itemType))}
          size="large"
          startIcon={getIcon(itemType)}
          variant="outlined"
        >
          Convert to {getItemTypeLabel(itemType)}
        </Button>
      </Grid>
    )),
    [item.type, handleChange],
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

  const interactionSection = useMemo(
    () => item.type === 'person' && (
      <CollapsibleSection
        content={(
          <NoteControl
            notes={item.notes}
            onChange={handleChangeNotes}
            noteType="interaction"
          />
        )}
        icon={InteractionIcon}
        id="interactions"
        initialExpanded={item.isNew}
        title="Interactions"
      />
    ),
    [handleChangeNotes, item.isNew, item.notes, item.type],
  );

  const actionSection = useMemo(
    () => (
      <CollapsibleSection
        content={(
          <NoteControl
            notes={item.notes}
            onChange={handleChangeNotes}
            noteType="action"
          />
        )}
        icon={ActionIcon}
        id="actions"
        initialExpanded={item.isNew}
        title="Actions"
      />
    ),
    [handleChangeNotes, item.isNew, item.notes],
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

  return (
    <BaseDrawer
      ActionProps={{
        canSave: isValid(item),
        itemHasNotes: true,
        itemIsNew: item.isNew,
        itemName: getItemName(item),
        onCancel: handleCancel,
        onDelete: handleDelete,
        onReport: hasReport ? handleReport : undefined,
        onSave: handleSaveButton,
        promptSave: !!item.dirty,
      }}
      alwaysTemporary={alwaysTemporary}
      itemKey={item.id}
      onBack={onBack}
      onClose={handleSaveAndClose}
      onExited={onExited}
      onUnmount={handleUnmount}
      open={open}
      stacked={stacked}
      typeIcon={getIconType(item.type)}
    >
      <Grid container spacing={2}>
        {duplicateAlert}

        {nameFields}

        {descriptionField}
        {summaryField}
        {tagsField}

        {maturityField}

        <Grid item xs={12}>
          {membersSection}
          {interactionSection}
          {actionSection}
          {groupsSection}
        </Grid>

        {emailField}
        {phoneField}

        {frequencyField}
      </Grid>

      <Grid container spacing={1} mt={1}>
        {archivedButton}
        {changeTypeButtons}
      </Grid>
    </BaseDrawer>
  );
}

export default ItemDrawer;
