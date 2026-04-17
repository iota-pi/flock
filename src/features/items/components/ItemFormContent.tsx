import { useCallback, useMemo, useState } from 'react'
import {
  Grid,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
} from '@mui/material'
import {
  LocalChangeItem,
  GroupItem,
  getItemName,
  Item,
} from '../../../state/items'
import { useItems } from '../../../state/selectors'
import {
  DeleteIcon,
  NotesIcon,
} from '../../../components/Icons'
import ItemFormDuplicateAlertSection from './ItemFormDuplicateAlertSection'
import ItemFormNotesSection from './ItemFormNotesSection'
import ItemFormFrequencySection from './ItemFormFrequencySection'
import ItemFormRelationshipsSection from './ItemFormRelationshipsSection'

type FrequencyUpdate = Partial<Pick<Item, 'prayerFrequency'>>
  & Partial<Pick<GroupItem, 'memberPrayerFrequency' | 'memberPrayerTarget'>>

const NAME_REQUIRED_MESSAGE = 'Name is required'
const DESCRIPTION_MAX_LENGTH = 500

interface ItemFormContentProps {
  item: LocalChangeItem<Item>,
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
  const [showDescription, setShowDescription] = useState((item.description || '').length > 0)

  const nameValue = item.name || ''
  const descriptionValue = item.description || ''
  const notesValue = Array.isArray(item.notes) ? item.notes : []
  const nameError = nameValue.trim().length === 0
  const descriptionError = descriptionValue.length > DESCRIPTION_MAX_LENGTH

  const handleNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      handleChange<Item>({ name: event.target.value })
    },
    [handleChange],
  )

  const handleDescriptionChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      handleChange<Item>({ description: event.target.value })
    },
    [handleChange],
  )

  const handleNotesChange = useCallback(
    (notes: Item['notes']) => {
      handleChange<Item>({ notes })
    },
    [handleChange],
  )

  const handleFrequencyChange = useCallback(
    (data: FrequencyUpdate) => {
      handleChange<Item>(data)
    },
    [handleChange],
  )

  const handleRelationshipsChange = useCallback(
    (data: Partial<Pick<GroupItem, 'members'>>) => {
      handleChange<Item>(data)
    },
    [handleChange],
  )

  const handleAddDescription = useCallback(() => setShowDescription(true), [])
  const handleRemoveDescription = useCallback(() => {
    handleChange<Item>({ description: '' })
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
      const potential = itemsByName[getItemName({ name: nameValue, type: item.type })]
      if (potential) {
        return potential.filter(i => i.type === item.type && i.id !== item.id)
      }
      return []
    },
    [item.id, item.type, itemsByName, nameValue],
  )

  const defaultExpandAccordions = !fromPrayerPage
  const hasDescription = !!descriptionValue
  const isArchivedInPrayer = fromPrayerPage && !!item.archived

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
                aria-label="Add description"
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
          error={nameError}
          fullWidth
          helperText={nameError ? NAME_REQUIRED_MESSAGE : ' '}
          label="Name"
          onChange={handleNameChange}
          required
          value={nameValue}
          variant="standard"
          slotProps={{
            htmlInput: { 'data-cy': 'name' },
            input: nameInputProps,
          }}
        />
      </Grid>
    ),
    [autoFocusName, handleNameChange, nameError, nameInputProps, nameValue],
  )

  const descriptionField = useMemo(
    () =>
      showDescription && (
        <Grid size={{ xs: 12 }}>
          <TextField
            error={descriptionError}
            fullWidth
            helperText={descriptionError ? `Description must be ${DESCRIPTION_MAX_LENGTH} characters or less` : ' '}
            label="Short Description"
            slotProps={{
              htmlInput: { 'data-cy': 'description' },
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title="Remove description">
                      <IconButton
                        aria-label="Remove description"
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
            onChange={handleDescriptionChange}
            value={descriptionValue}
            variant="standard"
          />
        </Grid>
      ),
    [descriptionError, descriptionValue, handleDescriptionChange, handleRemoveDescription, showDescription],
  )


  return (
    <Grid container spacing={2}>
      {!hideHeaderFields && (
        <ItemFormDuplicateAlertSection
          duplicateCount={duplicates.length}
          hasDescription={hasDescription}
          itemType={item.type}
        />
      )}
      {!hideHeaderFields && nameFields}
      {!hideHeaderFields && descriptionField}
      <ItemFormNotesSection
        disabled={isArchivedInPrayer}
        itemId={item.id}
        notes={notesValue}
        onChange={handleNotesChange}
      />
      <ItemFormFrequencySection
        defaultExpandAccordions={defaultExpandAccordions}
        disabled={isArchivedInPrayer}
        item={item}
        onChange={handleFrequencyChange}
      />
      {!hideRelationships && (
        <ItemFormRelationshipsSection
          defaultExpandAccordions={defaultExpandAccordions}
          item={item}
          onChange={handleRelationshipsChange}
        />
      )}
    </Grid>
  )
}

export default ItemFormContent
