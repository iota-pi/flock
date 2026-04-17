import { z } from 'zod'
import isEqual from 'lodash-es/isEqual'
import type { Item, ItemForType } from '../../../state/items'
import { frequencySchema, noteSchema } from '../../../shared/schemas/items'
import { ItemFormInputSchema } from '../../../shared/schemas/trpc'

export const ItemFormDraftSchema = ItemFormInputSchema.extend({
  memberPrayerFrequency: frequencySchema.optional(),
  memberPrayerTarget: z.enum(['one', 'all']).optional(),
  members: z.array(z.string()).optional(),
  notes: z.array(noteSchema),
  prayerFrequency: frequencySchema,
})

export type ItemFormDraftInput = z.input<typeof ItemFormDraftSchema>
export type ItemFormDraftValues = z.output<typeof ItemFormDraftSchema>

function cloneNotes(notes: Item['notes']) {
  return notes.map(note => ({ ...note }))
}

export function cloneItemFormDraftValues(values: ItemFormDraftValues): ItemFormDraftValues {
  return {
    ...values,
    members: values.members ? [...values.members] : undefined,
    notes: cloneNotes(values.notes),
  }
}

export function getItemFormDefaultValues(item: Item): ItemFormDraftValues {
  const groupOnlyValues = item.type === 'group'
    ? {
      memberPrayerFrequency: item.memberPrayerFrequency,
      memberPrayerTarget: item.memberPrayerTarget,
      members: [...item.members],
    }
    : {
      memberPrayerFrequency: undefined,
      memberPrayerTarget: undefined,
      members: undefined,
    }

  return {
    description: item.description || '',
    name: item.name,
    notes: cloneNotes(item.notes),
    prayerFrequency: item.prayerFrequency,
    ...groupOnlyValues,
  }
}

export function buildItemPatchFromDraftValues<T extends Item['type']>(
  prevValues: ItemFormDraftValues,
  nextValues: ItemFormDraftValues,
  itemType: T,
): Partial<ItemForType<T>> {
  const updates: Partial<ItemForType<T>> = {}

  if (prevValues.name !== nextValues.name) {
    updates.name = nextValues.name
  }

  if (prevValues.description !== nextValues.description) {
    updates.description = nextValues.description
  }

  if (prevValues.prayerFrequency !== nextValues.prayerFrequency) {
    updates.prayerFrequency = nextValues.prayerFrequency
  }

  if (!isEqual(prevValues.notes, nextValues.notes)) {
    updates.notes = cloneNotes(nextValues.notes)
  }

  if (itemType === 'group') {
    const groupUpdates = updates as Partial<ItemForType<'group'>>

    if (prevValues.memberPrayerFrequency !== nextValues.memberPrayerFrequency) {
      groupUpdates.memberPrayerFrequency = nextValues.memberPrayerFrequency
    }

    if (prevValues.memberPrayerTarget !== nextValues.memberPrayerTarget) {
      groupUpdates.memberPrayerTarget = nextValues.memberPrayerTarget
    }

    if (!isEqual(prevValues.members, nextValues.members)) {
      groupUpdates.members = nextValues.members ? [...nextValues.members] : []
    }
  }

  return updates
}
