import { Item, convertItem, getBlankGroup } from '../items'

export interface ItemMigration {
  description?: string,
  id: string,
  migrate: (args: { items: Item[] }) => Promise<Item[]>,
}

export const migrations: ItemMigration[] = [
  {
    description: 'Remove legacy tags property',
    id: 'remove-legacy-tags',
    migrate: async ({ items }) => {
      const updatedItems: Item[] = []
      for (const item of items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((item as any).tags) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (item as any).tags
          updatedItems.push(item)
        }
      }
      return updatedItems
    },
  },
  {
    description: 'Convert tags to groups',
    id: 'convert-tags-to-groups',
    migrate: async ({ items }) => {
      const allTags = new Set<string>()
      for (const item of items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tags = (item as any).tags as string[] | undefined
        if (!tags) {
          continue
        }
        for (const tag of tags) {
          allTags.add(tag)
        }
      }
      const d = new Date()
      const todaysDate = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
      const tagGroups = Array.from(allTags).map(tag => ({
        ...getBlankGroup(),
        name: tag,
        description: `Group migrated from tag (${todaysDate})`,
      }))
      const tagMap = Object.fromEntries(tagGroups.map(group => [group.name, group]))
      for (const item of items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tags = (item as any).tags as string[] | undefined
        if (!tags) {
          continue
        }
        for (const tag of tags) {
          const group = tagMap[tag]
          group.members.push(item.id)
        }
      }
      const updatedItems: typeof items = Object.values(tagMap)
      return updatedItems
    },
  },
  {
    description: 'Convert general items to people',
    id: 'convert-general-to-person-2',
    migrate: async ({ items }) => {
      const updatedItems: typeof items = []
      for (const item of items) {
        if ((item.type as string) === 'general') {
          updatedItems.push(convertItem(item, 'person'))
        }
      }
      return updatedItems
    },
  },
  {
    description: 'Merge first and last names for people',
    id: 'merge-people-names-2',
    migrate: async ({ items }) => {
      const updatedItems: typeof items = []
      for (const item of items) {
        if (item.type === 'person') {
          const { firstName, lastName } = item as unknown as { firstName: string, lastName: string }
          const newName = `${firstName ?? ''} ${lastName ?? ''}`.trim()
          if (newName) {
            item.name = newName
            updatedItems.push(item)
          }
        }
      }
      return updatedItems
    },
  },
  {
    description: 'Initialize item version',
    id: 'add-version-to-items',
    migrate: async ({ items }) => {
      // Return all items to force a save with version 1 (set by supplyMissingAttributes)
      return [...items]
    },
  },
]
