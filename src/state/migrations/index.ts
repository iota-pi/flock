import { setMetadata, storeItems } from '../../api/Vault'
import { clearQueryCache } from '../../api/queries'
import { Item, convertItem, getBlankGroup } from '../items'
import { AccountMetadata } from '../account'

export interface ItemMigration {
  description?: string,
  id: string,
  migrate: (args: { items: Item[] }) => Promise<boolean>,
}

const migrations: ItemMigration[] = [
  // TODO remove tags from old items in future migration
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
      if (updatedItems.length > 0) {
        try {
          await storeItems(updatedItems)
        } catch (error) {
          console.warn('Error storing items during migration')
          console.error(error)
          return false
        }
      }
      return true
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
      if (updatedItems.length > 0) {
        try {
          await storeItems(updatedItems)
        } catch (error) {
          console.warn('Error storing items during migration')
          console.error(error)
          return false
        }
      }
      return true
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
      if (updatedItems.length > 0) {
        try {
          await storeItems(updatedItems)
        } catch (error) {
          console.warn('Error storing items during migration')
          console.error(error)
          return false
        }
      }
      return true
    },
  },
]

async function migrateItems(items: Item[], metadata: AccountMetadata) {
  const reversedMigrations = migrations.slice()
  const previousMigrations = (metadata.completedMigrations as string[]) || []
  const completedMigrations = previousMigrations.slice()

  for (const migration of reversedMigrations) {
    if (completedMigrations.includes(migration.id)) {
      continue
    }

    try {
      const successful = await migration.migrate({ items })
      if (successful) {
        completedMigrations.push(migration.id)
      } else {
        console.warn(`Migration failed: ${migration.id}`)
      }
    } catch (error) {
      console.warn(`Uncaught error in migration ${migration.id}`)
      console.error(error)
    }
  }

  if (previousMigrations.length !== completedMigrations.length) {
    await setMetadata({ ...metadata, completedMigrations })
    clearQueryCache()
  }
  return completedMigrations
}

export default migrateItems
