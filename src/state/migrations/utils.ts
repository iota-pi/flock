import { Item } from '../items'
import { migrations } from './migrations'

export async function runAllMigrationsInMemory(items: Item[]): Promise<Item[]> {
  const reversedMigrations = migrations.slice().reverse()
  let currentItems = [...items]

  for (const migration of reversedMigrations) {
    const updated = await migration.migrate({ items: currentItems })
    if (updated.length > 0) {
      const updatedMap = new Map(updated.map(i => [i.id, i]))
      currentItems = currentItems.map(item => updatedMap.get(item.id) || item)
    }
  }

  return currentItems
}
