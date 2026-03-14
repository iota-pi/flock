import { ChangeEvent, useCallback, useMemo, useState } from 'react'
import {
  Collapse,
  Grid,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
} from '@mui/material'
import {
  DirtyItem,
  getItemName,
  GroupItem,
  Item,
} from '../../state/items'
import { useItems } from '../../state/selectors'
import FrequencyControls from '../FrequencyControls'
import GroupDisplay from '../GroupDisplay'
import MemberDisplay from '../MemberDisplay'
import CollapsibleSection from './utils/CollapsibleSection'
import DuplicateAlert from './utils/DuplicateAlert'
import { usePrevious } from '../../utils'
import {
  DeleteIcon,
  FrequencyIcon,
  GroupIcon,
  NotesIcon,
  PersonIcon,
} from '../Icons'
import { getLastPrayedFor } from '../../utils/prayer'
import NotesSection from '../NotesSection'


function getValue(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
  return event.target.value
}

export interface ItemFormContentProps {
  item: DirtyItem<Item>,
  handleChange: <T extends Item>(data: Partial<T> | ((prev: Item) => Item)) => void,
  autoFocusName?: boolean,
  fromPrayerPage?: boolean,
  hideHeaderFields?: boolean,
  hideRelationships?: boolean,
}

function ItemFormContent({
  item,
  handleChange,
  autoFocusName = true,
  fromPrayerPage = false,
  hideHeaderFields = false,
  hideRelationships = false,
}: ItemFormContentProps) {
  const allItems = useItems()
  const [showDescription, setShowDescription] = useState(!!item.description)
  const prevItemId = usePrevious(item.id)

  // Reset showDescription when item changes
  if (prevItemId !== item.id && showDescription !== !!item.description) {
    setShowDescription(!!item.description)
  }

  const handleAddDescription = useCallback(() => setShowDescription(true), [])
  const handleRemoveDescription = useCallback(() => {
    handleChange({ description: '' })
    setShowDescription(false)
  }, [handleChange])

  const itemsByName = useMemo(
    () => {
      const result: { [name: string]: Item[] | undefined } = {}
      for (const i of allItems) {
        const name = getItemName(i)
        if (result[name] === undefined) {
          result[name] = [i]
        } else {
          result[name]!.push(i)
        }
      }
      return result
    },
    [allItems],
  )

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

  const defaultExpandAccordions = !fromPrayerPage
  const hasDescription = !!item.description
  const isArchivedInPrayer = fromPrayerPage && !!item.archived

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

  const nameInputProps = useMemo(
    () => {
      if (showDescription) {
        return undefined
      }

      return {
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
      }
    },
    [handleAddDescription, showDescription],
  )

  const nameFields = useMemo(
    () => (
      <Grid size={{ xs: 12 }}>
        <TextField
          autoFocus={autoFocusName}
          fullWidth
          key={item.id}
          label="Name"
          onChange={event => handleChange({ name: getValue(event) })}
          required
          value={item.name}
          variant="standard"
          slotProps={{
            htmlInput: { 'data-cy': 'name' },
            input: nameInputProps,
          }}
        />
      </Grid>
    ),
    [autoFocusName, item.name, handleChange, item.id, nameInputProps],
  )

  const descriptionField = useMemo(
    () =>
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
      ),
    [handleChange, handleRemoveDescription, item.description, showDescription],
  )

  const notesSection = useMemo(
    () => (
      <Grid
        size={{ xs: 12 }}
        mt={1}
        sx={isArchivedInPrayer ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
      >
        <NotesSection
          notes={item.notes}
          onChange={notes => handleChange({ notes })}
        />
      </Grid>
    ),
    [handleChange, isArchivedInPrayer, item.notes],
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
          disabled={isArchivedInPrayer}
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
      isArchivedInPrayer,
      item.id,
      item.prayerFrequency,
      memberFrequency,
      memberTarget,
      lastPrayer,
    ],
  )

  const members = item.type === 'group' ? item.members : undefined
  const membersSection = useMemo(
    () =>
      members !== undefined && (
        <CollapsibleSection
          content={(
            <MemberDisplay
              group={item as GroupItem}
              memberIds={members}
              onChange={group => handleChange<GroupItem>(group)}
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
    () =>
      item.type === 'person' && (
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
    <Grid container spacing={2}>
      {!hideHeaderFields && duplicateAlert}
      {!hideHeaderFields && nameFields}
      {!hideHeaderFields && descriptionField}
      {notesSection}
      {frequencySection}
      {!hideRelationships && (
        <Grid size={{ xs: 12 }}>
          {membersSection}
          {groupsSection}
        </Grid>
      )}
    </Grid>
  )
}

export default ItemFormContent
