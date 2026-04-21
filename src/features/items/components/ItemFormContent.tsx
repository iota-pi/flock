import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Grid,
  IconButton,
  InputAdornment,
  Tooltip,
} from '@mui/material'
import {
  LocalChangeItem,
  Item,
} from '../../../state/items'
import DebouncedTextField, { type DebouncedTextFieldControls } from '../../../components/ui/DebouncedTextField'
import {
  DeleteIcon,
  NotesIcon,
} from '../../../components/Icons'
import ItemFormDuplicateAlertSection from './ItemFormDuplicateAlertSection'
import ItemFormNotesSection from './ItemFormNotesSection'
import ItemFormFrequencySection from './ItemFormFrequencySection'
import ItemFormRelationshipsSection from './ItemFormRelationshipsSection'
import type { GroupItem } from '../../../shared/schemas/items'

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
  const [showDescription, setShowDescription] = useState((item.description || '').length > 0)
  const [nameValue, setNameValue] = useState(item.name || '')
  const [descriptionValue, setDescriptionValue] = useState(item.description || '')
  const descriptionDebounceControlsRef = useRef<DebouncedTextFieldControls | null>(null)

  const handleNameCommit = useCallback(
    (nextName: string) => {
      handleChange<Item>({ name: nextName })
    },
    [handleChange],
  )

  const handleDescriptionCommit = useCallback(
    (nextDescription: string) => {
      handleChange<Item>({ description: nextDescription })
    },
    [handleChange],
  )
  const notesValue = Array.isArray(item.notes) ? item.notes : []
  const nameError = nameValue.trim().length === 0
  const descriptionError = descriptionValue.length > DESCRIPTION_MAX_LENGTH

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
    descriptionDebounceControlsRef.current?.cancel()
    setDescriptionValue('')
    handleChange<Item>({ description: '' })
    setShowDescription(false)
  }, [handleChange])

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
        <DebouncedTextField
          autoFocus={autoFocusName}
          debounceMs={1000}
          error={nameError}
          fullWidth
          helperText={nameError ? NAME_REQUIRED_MESSAGE : ' '}
          label="Name"
          onCommit={handleNameCommit}
          onValueChange={setNameValue}
          required
          value={item.name || ''}
          variant="standard"
          slotProps={{
            htmlInput: { 'data-cy': 'name' },
            input: nameInputProps,
          }}
        />
      </Grid>
    ),
    [autoFocusName, handleNameCommit, item.name, nameError, nameInputProps],
  )

  const descriptionField = useMemo(
    () =>
      showDescription && (
        <Grid size={{ xs: 12 }}>
          <DebouncedTextField
            debounceControlsRef={descriptionDebounceControlsRef}
            debounceMs={1000}
            error={descriptionError}
            fullWidth
            helperText={descriptionError ? `Description must be ${DESCRIPTION_MAX_LENGTH} characters or less` : ' '}
            label="Short Description"
            onCommit={handleDescriptionCommit}
            onValueChange={setDescriptionValue}
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
            value={item.description || ''}
            variant="standard"
          />
        </Grid>
      ),
    [descriptionError, handleDescriptionCommit, handleRemoveDescription, item.description, showDescription],
  )


  return (
    <Grid container spacing={2}>
      {!hideHeaderFields && (
        <ItemFormDuplicateAlertSection
          hasDescription={hasDescription}
          itemId={item.id}
          itemType={item.type}
          nameValue={nameValue}
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
