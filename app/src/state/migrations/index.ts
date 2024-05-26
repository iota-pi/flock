import { clearItemCache, setMetadata, storeItems } from '../../api/Vault'
import store from '../../store'
import { Item } from '../items'

export interface ItemMigration {
  dependencies: string[],
  description?: string,
  id: string,
  migrate: (args: { items: Item[] }) => Promise<boolean>,
}

const migrations: ItemMigration[] = [
  {
    dependencies: [],
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
    dependencies: [],
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

async function migrateItems(items: Item[]) {
  // Reverse migrations to reduce dependency conflicts
  // (assuming new migrations are added to the top of the array)
  const reversedMigrations = migrations.slice().reverse()
  const metadata = store.getState().account.metadata
  const previousMigrations = (metadata.completedMigrations as string[]) || []
  const completedMigrations = previousMigrations.slice()

  let ranMigrations = true
  while (ranMigrations) {
    ranMigrations = false

    for (const migration of reversedMigrations) {
      if (completedMigrations.includes(migration.id)) {
        continue
      }

      const missingDeps: string[] = []
      for (const dep of migration.dependencies) {
        if (!completedMigrations.includes(dep)) {
          missingDeps.push(dep)
        }
      }
      if (missingDeps.length > 0) {
        console.warn(
          `Skipping migration: ${migration.id}\n`,
          `Dependencies not yet satisfied: ${missingDeps.join(', ')}`,
        )
        continue
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const successful = await migration.migrate({ items })
        if (successful) {
          ranMigrations = true
          completedMigrations.push(migration.id)
        } else {
          console.warn(`Migration failed: ${migration.id}`)
        }
      } catch (error) {
        console.warn(`Uncaught error in migration ${migration.id}`)
        console.error(error)
      }
    }
  }

  if (previousMigrations.length !== completedMigrations.length) {
    await setMetadata({ ...metadata, completedMigrations })
    clearItemCache()
  }
  return completedMigrations
}

export default migrateItems
