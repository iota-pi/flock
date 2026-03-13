import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  Collapse,
  Grid,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
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
import { isSameDay, usePrevious } from '../../utils'
import {
  ArchiveIcon,
  DeleteIcon,
  FrequencyIcon,
  getIcon,
  getIconType,
  GroupIcon,
  MoreOptionsIcon,
  NotesIcon,
  PersonIcon,
  PrayerIcon,
  UnarchiveIcon,
} from '../Icons'
import { getLastPrayedFor } from '../../utils/prayer'
import { useDeleteItemsMutation, useStoreItemsMutation } from '../../api/queries'
import NotesSection from '../NotesSection'


export interface Props extends BaseDrawerProps {
  fromPrayerPage?: boolean,
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
  fromPrayerPage = false,
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
  const { mutateAsync: deleteItem } = useDeleteItemsMutation()
  const { mutate: storeItems } = useStoreItemsMutation()

  const [disableAutoSave, setDisableAutoSave] = useState(false)
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null)
  const [showDescription, setShowDescription] = useState(!!item.description)
  const menuOpen = Boolean(menuAnchorEl)

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

  // Reset showDescription when item changes
  if (prevItem?.id !== item.id && showDescription !== !!item.description) {
    setShowDescription(!!item.description)
  }

  const duplicates = useMemo(
    () => {
      const potential = itemsByName[getItemName(item)]
      if (potential) {
        return potential.filter(i => i.type === item.type && i.id !== item.id)
      }
      return []
    },
    [item, itemsByName],
  )

  const handleChange = useCallback(
    <T extends Item>(
      data: Partial<T> | ((prev: Item) => Item),
    ) => {
      setDisableAutoSave(false)
      if (typeof data === 'function') {
        return onChange(originalItem => dirtyItem(data(originalItem)))
      }
      return onChange(dirtyItem(data))
    },
    [onChange],
  )

  const handleAddDescription = useCallback(() => setShowDescription(true), [])
  const handleMenuClose = useCallback(() => setMenuAnchorEl(null), [])
  const handleRemoveDescription = useCallback(() => {
    handleChange({ description: '' })
    setShowDescription(false)
  }, [handleChange])

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
    [item.id, memberGroups, storeItems],
  )

  const handleSave = useCallback(
    (itemToSave: DirtyItem<Item>) => {
      if ((itemToSave.dirty || itemToSave.isNew) && isValid(itemToSave)) {
        setDisableAutoSave(true)
        const clean = cleanItem(itemToSave)
        if (isItem(clean)) {
          storeItems(clean)
        }
        return clean
      }
      return undefined
    },
    [storeItems],
  )
  const handleClose = useCallback(
    (disableSave?: boolean) => {
      if (!disableSave) {
        handleSave(item)
      }
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
  const handleCancel = useCallback(
    () => {
      setDisableAutoSave(true)
      onClose()
    },
    [onClose],
  )
  const handleDelete = useCallback(
    () => {
      removeFromAllGroups()
      deleteItem(item.id)
        .catch(error => console.error(error))
      onClose()
    },
    [deleteItem, item.id, onClose, removeFromAllGroups],
  )

  const handleUnmount = useCallback(
    () => {
      if (!disableAutoSave) {
        handleSave(item)
      }
    },
    [disableAutoSave, handleSave, item],
  )

  if (open && prevItem && prevItem.id !== item.id) {
    handleSave(prevItem)
  }

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
  const defaultExpandAccordions = !fromPrayerPage
  const duplicateAlert = useMemo(
    () => (
      <Grid size={{ xs: 12 }} mt={-1}>
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
      <Grid size={{ xs: 12 }}>
        <TextField
          autoFocus
          fullWidth
          key={item.id}
          label="Name"
          onChange={
            event => handleChange({ name: getValue(event) })
          }
          required
          value={item.name}
          variant="standard"
          slotProps={{
            htmlInput: { 'data-cy': 'name' },
            input: !showDescription ? {
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title="Add description">
                    <IconButton
                      data-cy="add-description"
                      onClick={handleAddDescription}
                      size="small"
                    >
                      <NotesIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            } : undefined,
          }}
        />
      </Grid>
    ),
    [item.name, handleChange, item.id, showDescription, handleAddDescription],
  )

  const { archived } = item
  const descriptionField = useMemo(
    () => (
      showDescription && (
        <Grid size={{ xs: 12 }}>
          <TextField
            fullWidth
            label="Short Description"
            slotProps={{
              htmlInput: { 'data-cy': 'description' },
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title="Remove description">
                      <IconButton
                        data-cy="remove-description"
                        onClick={handleRemoveDescription}
                        size="small"
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ),
              },
            }}
            onChange={event => handleChange({ description: getValue(event) })}
            value={item.description}
            variant="standard"
          />
        </Grid>
      )
    ),
    [handleChange, item.description, showDescription, handleRemoveDescription],
  )
  const notesSection = useMemo(
    () => (
      <Grid size={{ xs: 12 }} mt={1}>
        <NotesSection
          notes={item.notes}
          onChange={notes => handleChange({ notes })}
        />
      </Grid>
    ),
    [handleChange, item.notes],
  )

  const lastPrayer = getLastPrayedFor(item)
  const memberFrequency = item.type === 'group' ? item.memberPrayerFrequency : undefined
  const memberTarget = item.type === 'group' ? item.memberPrayerTarget : undefined
  const frequencySection = useMemo(
    () => (
      <Grid size={{ xs: 12 }}>
        <CollapsibleSection
          content={(
            <FrequencyControls
              id={item.id}
              lastPrayer={lastPrayer}
              onChange={handleChange}
              prayerFrequency={item.prayerFrequency}
              memberPrayerFrequency={memberFrequency}
              memberPrayerTarget={memberTarget}
            />
          )}
          icon={FrequencyIcon}
          id="frequency"
          initialExpanded={defaultExpandAccordions}
          title="Prayer Frequency"
        />
      </Grid>
    ),
    [
      defaultExpandAccordions,
      handleChange,
      item.id,
      item.prayerFrequency,
      memberFrequency,
      memberTarget,
      lastPrayer,
    ],
  )

  const archiveMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="archived"
        disabled={item.isNew}
        onClick={() => {
          handleChange({ archived: !archived })
          handleMenuClose()
        }}
      >
        <ListItemIcon>
          {archived ? <UnarchiveIcon /> : <ArchiveIcon />}
        </ListItemIcon>
        <ListItemText>{archived ? 'Unarchive' : 'Archive'}</ListItemText>
      </MenuItem>
    ),
    [archived, handleChange, item.isNew, handleMenuClose],
  )
  const changeTypeMenuItems = useMemo(
    () => ITEM_TYPES.filter(t => t !== item.type).map(itemType => (
      <MenuItem
        data-cy="change-type"
        key={itemType}
        onClick={() => {
          handleChange(i => convertItem(i, itemType))
          handleMenuClose()
        }}
      >
        <ListItemIcon>
          {getIcon(itemType)}
        </ListItemIcon>
        <ListItemText>Convert to {getItemTypeLabel(itemType)}</ListItemText>
      </MenuItem>
    )),
    [item.type, handleChange, handleMenuClose],
  )
  const isPrayedForToday = isSameDay(new Date(), new Date(lastPrayer))
  const markPrayedMenuItem = useMemo(
    () => (
      <MenuItem
        data-cy="mark-prayed"
        disabled={item.isNew}
        onClick={() => {
          handleChange(prev => {
            let prayedFor = prev.prayedFor
            if (isPrayedForToday) {
              const startOfDay = new Date()
              startOfDay.setHours(0, 0, 0, 0)
              prayedFor = prayedFor.filter(d => d < startOfDay.getTime())
            } else {
              prayedFor = [...prayedFor, new Date().getTime()]
            }
            return { ...prev, prayedFor }
          })
          handleMenuClose()
        }}
      >
        <ListItemIcon>
          <PrayerIcon />
        </ListItemIcon>
        <ListItemText>
          {isPrayedForToday ? 'Unmark Prayed' : 'Mark as Prayed Today'}
        </ListItemText>
      </MenuItem>
    ),
    [handleChange, item.isNew, isPrayedForToday, handleMenuClose],
  )

  const headerActions = useMemo(
    () => (
      <>
        <IconButton
          data-cy="item-menu-button"
          onClick={event => setMenuAnchorEl(event.currentTarget)}
          size="large"
        >
          <MoreOptionsIcon />
        </IconButton>

        <Menu
          anchorEl={menuAnchorEl}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          onClose={handleMenuClose}
          open={menuOpen}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          {markPrayedMenuItem}
          {archiveMenuItem}
          {changeTypeMenuItems}
        </Menu>
      </>
    ),
    [archiveMenuItem, changeTypeMenuItems, handleMenuClose, markPrayedMenuItem, menuAnchorEl, menuOpen],
  )

  const members = item.type === 'group' ? item.members : undefined
  const membersSection = useMemo(
    () => members !== undefined && (
      <CollapsibleSection
        content={(
          <MemberDisplay
            memberIds={members}
            onChange={group => handleChange<GroupItem>(group)}
            group={item as GroupItem}
          />
        )}
        icon={PersonIcon}
        id="members"
        initialExpanded={defaultExpandAccordions}
        title="Members"
      />
    ),
    [defaultExpandAccordions, handleChange, item, members],
  )

  const groupsSection = useMemo(
    () => item.type === 'person' && (
      <CollapsibleSection
        content={<GroupDisplay itemId={item.id} />}
        icon={GroupIcon}
        id="groups"
        initialExpanded={defaultExpandAccordions}
        title="Groups"
      />
    ),
    [defaultExpandAccordions, item.id, item.type],
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
      headerActions={headerActions}
      itemKey={item.id}
      onBack={onBack}
      onClose={handleClose}
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
        {notesSection}
        {frequencySection}

        <Grid size={{ xs: 12 }}>
          {membersSection}
          {groupsSection}
        </Grid>
      </Grid>
    </BaseDrawer>
  )
}

export default ItemDrawer
