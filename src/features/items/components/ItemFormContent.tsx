import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Grid,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
} from '@mui/material'
import {
  DirtyItem,
  getItemName,
  Item,
} from '../../../state/items'
import { zodResolver } from '@hookform/resolvers/zod'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { useItems } from '../../../state/selectors'
import { usePrevious } from '../../../utils'
import {
  DeleteIcon,
  NotesIcon,
} from '../../../components/Icons'
import { ItemFormInputSchema } from '../../../shared/syncSchemas'
import ItemFormDuplicateAlertSection from './ItemFormDuplicateAlertSection'
import ItemFormNotesSection from './ItemFormNotesSection'
import ItemFormFrequencySection from './ItemFormFrequencySection'
import ItemFormRelationshipsSection from './ItemFormRelationshipsSection'


function getValue(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
  return event.target.value
}

type ItemFormFields = z.input<typeof ItemFormInputSchema>
type ItemFormParsed = z.output<typeof ItemFormInputSchema>

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
  const {
    control,
    reset,
    formState: { errors },
  } = useForm<ItemFormFields, unknown, ItemFormParsed>({
    resolver: zodResolver(ItemFormInputSchema),
    mode: 'onChange',
    defaultValues: {
      name: item.name,
      description: item.description || '',
    },
  })

  useEffect(() => {
    reset({
      name: item.name,
      description: item.description || '',
    })
  }, [item.description, item.id, item.name, reset])

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
        <Controller
          control={control}
          name="name"
          render={({ field }) => (
            <TextField
              autoFocus={autoFocusName}
              error={!!errors.name}
              fullWidth
              helperText={errors.name?.message || ' '}
              key={item.id}
              label="Name"
              onChange={event => {
                field.onChange(event)
                handleChange({ name: getValue(event) })
              }}
              required
              value={field.value}
              variant="standard"
              slotProps={{
                htmlInput: { 'data-cy': 'name' },
                input: nameInputProps,
              }}
            />
          )}
        />
      </Grid>
    ),
    [autoFocusName, control, errors.name, handleChange, item.id, nameInputProps],
  )

  const descriptionField = useMemo(
    () =>
      showDescription && (
        <Grid size={{ xs: 12 }}>
          <Controller
            control={control}
            name="description"
            render={({ field }) => (
              <TextField
                error={!!errors.description}
                fullWidth
                helperText={errors.description?.message || ' '}
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
                onChange={event => {
                  field.onChange(event)
                  handleChange({ description: getValue(event) })
                }}
                value={field.value}
                variant="standard"
              />
            )}
          />
        </Grid>
      ),
    [control, errors.description, handleChange, handleRemoveDescription, showDescription],
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
        notes={item.notes}
        onChange={notes => handleChange({ notes })}
      />
      <ItemFormFrequencySection
        defaultExpandAccordions={defaultExpandAccordions}
        disabled={isArchivedInPrayer}
        item={item}
        onChange={handleChange}
      />
      {!hideRelationships && (
        <ItemFormRelationshipsSection
          defaultExpandAccordions={defaultExpandAccordions}
          item={item}
          onChange={handleChange}
        />
      )}
    </Grid>
  )
}

export default ItemFormContent
