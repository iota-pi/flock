import { setMetadata, storeItems } from '../../api/VaultLazy'
import { clearQueryCache } from '../../api/queries'
import { Item } from '../items'
import { AccountMetadata } from '../account'
import { migrations } from './migrations'

async function migrateItems(items: Item[], metadata: AccountMetadata) {
  const reversedMigrations = migrations.slice().reverse()
  const previousMigrations = (metadata.completedMigrations as string[]) || []
  const completedMigrations = previousMigrations.slice()

  for (const migration of reversedMigrations) {
    if (completedMigrations.includes(migration.id)) {
      continue
    }

    try {
      const itemsToStore = await migration.migrate({ items })
      if (itemsToStore.length > 0) {
        await storeItems(itemsToStore)
      }
      completedMigrations.push(migration.id)
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
