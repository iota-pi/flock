import { generateItemId } from '../../utils'
import { Item, getBlankGroup } from '../items'

export type MigrationYieldContext = {
  batchSize: number
  yieldControl: () => Promise<void>
}

type LegacyTaggedItem = Item & { tags?: string[] }

function getLegacyTags(item: Item): string[] {
  const tags = (item as LegacyTaggedItem).tags
  if (!Array.isArray(tags)) {
    return []
  }

  return tags
    .filter(tag => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0)
}

async function maybeYield(index: number, context: MigrationYieldContext): Promise<void> {
  if ((index + 1) % context.batchSize !== 0) {
    return
  }

  await context.yieldControl()
}

export async function convertLegacyTagsToGroups(
  items: Item[],
  context: MigrationYieldContext,
): Promise<Item[]> {
  const allTags = new Set<string>()

  for (let index = 0; index < items.length; index++) {
    const tags = getLegacyTags(items[index])
    for (const tag of tags) {
      allTags.add(tag)
    }

    await maybeYield(index, context)
  }

  if (allTags.size === 0) {
    return []
  }

  const d = new Date()
  const todaysDate = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
  const tagGroups = Array.from(allTags).map(tag => ({
    ...getBlankGroup(),
    name: tag,
    description: `Group migrated from tag (${todaysDate})`,
  }))

  const tagMap = new Map(tagGroups.map(group => [group.name, group]))

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const tags = getLegacyTags(item)

    for (const tag of tags) {
      const group = tagMap.get(tag)
      if (group) {
        group.members.push(item.id)
      }
    }

    await maybeYield(index, context)
  }

  return Array.from(tagMap.values())
}

export async function mergeLegacyPersonNames(
  items: Item[],
  context: MigrationYieldContext,
): Promise<Item[]> {
  const updatedItems: Item[] = []

  for (let index = 0; index < items.length; index++) {
    const item = items[index]

    if (item.type === 'person') {
      const { firstName, lastName } = item as unknown as { firstName?: string; lastName?: string }
      const newName = `${firstName ?? ''} ${lastName ?? ''}`.trim()

      if (newName.length > 0) {
        item.name = newName
        updatedItems.push(item)
      }
    }

    await maybeYield(index, context)
  }

  return updatedItems
}

export async function migrateSummaryToNotes(
  items: Item[],
  context: MigrationYieldContext,
): Promise<Item[]> {
  const updatedItems: Item[] = []

  for (let index = 0; index < items.length; index++) {
    const item = items[index] as Item & { summary?: string }

    if (item.summary && item.notes.length === 0) {
      item.notes = [
        {
          id: generateItemId(),
          text: item.summary,
          archived: false,
          time: item.created,
        }
      ]
      delete item.summary
      updatedItems.push(item)
    }

    await maybeYield(index, context)
  }

  return updatedItems
}