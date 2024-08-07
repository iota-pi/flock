import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  Button,
  Collapse,
  Grid,
  IconButton,
  TextField,
  Tooltip,
} from '@mui/material'
import {
  cleanItem,
  compareNames,
  convertItem,
  dirtyItem,
  DirtyItem,
  getItemName,
  getItemTypeLabel,
  GroupItem,
  isItem,
  isValid,
  Item,
  ITEM_TYPES,
} from '../../state/items'
import { useItems } from '../../state/selectors'
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer'
import FrequencyControls from '../FrequencyControls'
import GroupDisplay from '../GroupDisplay'
import MemberDisplay from '../MemberDisplay'
import CollapsibleSection from './utils/CollapsibleSection'
import DuplicateAlert from './utils/DuplicateAlert'
import { usePrevious } from '../../utils'
import {
  ArchiveIcon,
  getIcon,
  getIconType,
  GroupIcon,
  NotesIcon,
  PersonIcon,
  UnarchiveIcon,
} from '../Icons'
import { getLastPrayedFor } from '../../utils/prayer'
import { deleteItems, storeItems } from '../../api/Vault'


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
  return event.target.value
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
  const groups = useItems<GroupItem>('group')
  const items = useItems()

  const [cancelled, setCancelled] = useState(false)
  const [duplicates, setDuplicates] = useState<Item[]>([])
  const [forceShowDescription, setShowDescription] = useState(false)

  const prevItem = usePrevious(item)

  const memberGroups = useMemo(
    () => (
      item.type === 'person'
        ? groups.filter(g => g.members.includes(item.id)).sort(compareNames)
        : []
    ),
    [item.id, item.type, groups],
  )

  const itemsByName = useMemo(
    () => {
      const result: { [name: string]: Item[] | undefined } = {}
      for (const i of items) {
        const name = getItemName(i)
        if (result[name] === undefined) {
          result[name] = [i]
        } else {
          result[name]!.push(i)
        }
      }
      return result
    },
    [items],
  )

  useEffect(
    () => {
      if (prevItem?.id !== item.id) {
        setShowDescription(!!item.description)
      }
    },
    [item.description, item.id, prevItem?.id],
  )
  const showDescription = forceShowDescription || !!item.description

  useEffect(
    () => {
      const potential = itemsByName[getItemName(item)]
      if (potential) {
        setDuplicates(
          potential.filter(i => i.type === item.type && i.id !== item.id),
        )
      } else {
        setDuplicates([])
      }
    },
    [item, itemsByName],
  )

  const handleClickAddDescription = useCallback(() => setShowDescription(true), [])
  const handleChange = useCallback(
    <T extends Item>(
      data: Partial<T> | ((prev: Item) => Item),
    ) => {
      if (typeof data === 'function') {
        return onChange(originalItem => dirtyItem(data(originalItem)))
      }
      return onChange(dirtyItem(data))
    },
    [onChange],
  )

  const removeFromAllGroups = useCallback(
    () => {
      const updatedGroupItems: GroupItem[] = []
      for (const group of memberGroups) {
        const newGroup: GroupItem = {
          ...group,
          members: group.members.filter(m => m !== item.id),
        }
        updatedGroupItems.push(newGroup)
      }
      storeItems(updatedGroupItems)
    },
    [item.id, memberGroups],
  )

  const handleSave = useCallback(
    (itemToSave: DirtyItem<Item>) => {
      if ((itemToSave.dirty || itemToSave.isNew) && isValid(itemToSave)) {
        const clean = cleanItem(itemToSave)
        if (isItem(clean)) {
          storeItems(clean)
        }
        return clean
      }
      return undefined
    },
    [],
  )
  const handleSaveAndClose = useCallback(
    () => {
      handleSave(item)
      onClose()
    },
    [handleSave, item, onClose],
  )
  const handleSaveButton = useCallback(
    () => {
      const clean = handleSave(item)
      if (clean) {
        onChange(clean)
      }
    },
    [handleSave, item, onChange],
  )
  const handleCancel = useCallback(() => setCancelled(true), [])
  const handleDelete = useCallback(
    () => {
      removeFromAllGroups()
      deleteItems(item.id)
      onClose()
    },
    [onClose, item.id, removeFromAllGroups],
  )

  const handleUnmount = useCallback(
    () => {
      if (!cancelled) {
        handleSave(item)
      }
    },
    [cancelled, handleSave, item],
  )

  useEffect(
    () => {
      if (cancelled) onClose()
    },
    [cancelled, onClose],
  )
  useEffect(
    () => {
      if (open && prevItem && prevItem.id !== item.id) {
        handleSave(prevItem)
      }
    },
    [handleSave, item.id, open, prevItem],
  )
  useEffect(
    () => {
      if (item.dirty && !item.isNew) {
        const timeout = setTimeout(
          () => handleSave(item),
          10000,
        )
        return () => clearTimeout(timeout)
      }
      return undefined
    },
    [handleSave, item],
  )

  const hasDescription = !!item.description
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
  )

  const nameFields = useMemo(
    () => (
      <Grid item xs={showDescription ? 12 : 10} lg={showDescription ? 12 : 11}>
        <TextField
          autoFocus
          data-cy="name"
          fullWidth
          key={item.id}
          label="Name"
          onChange={
            event => handleChange({ name: getValue(event) })
          }
          required
          value={item.name}
          variant="standard"
        />
      </Grid>
    ),
    [item.name, handleChange, item.id, showDescription],
  )

  const { archived } = item
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
  )
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
  )

  const lastPrayer = getLastPrayedFor(item)
  const memberFrequency = item.type === 'group' ? item.memberPrayerFrequency : undefined
  const frequencyFields = useMemo(
    () => (
      <Grid item xs={12}>
        <FrequencyControls
          lastPrayer={lastPrayer}
          onChange={handleChange}
          prayerFrequency={item.prayerFrequency}
          memberPrayerFrequency={memberFrequency}
        />
      </Grid>
    ),
    [
      handleChange,
      item.prayerFrequency,
      item.type,
      memberFrequency,
      lastPrayer,
    ],
  )

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
  )
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
  )

  const members = item.type === 'group' ? item.members : undefined
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
  )

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
  )

  return (
    <BaseDrawer
      ActionProps={{
        canSave: isValid(item),
        itemIsNew: item.isNew,
        itemName: getItemName(item),
        onCancel: handleCancel,
        onDelete: handleDelete,
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

        <Grid item xs={12}>
          {membersSection}
          {groupsSection}
        </Grid>

        {frequencyFields}
      </Grid>

      <Grid container spacing={1} mt={1}>
        {archivedButton}
        {changeTypeButtons}
      </Grid>
    </BaseDrawer>
  )
}

export default ItemDrawer
