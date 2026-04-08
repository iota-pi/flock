import { Item } from '../items'
import { migrations } from './migrations'

const DEFAULT_BATCH_SIZE = 200

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

export async function runAllMigrationsInMemory(items: Item[]): Promise<Item[]> {
  const reversedMigrations = migrations.slice().reverse()
  let currentItems = [...items]

  for (const migration of reversedMigrations) {
    const batchSize = migration.batchSize || DEFAULT_BATCH_SIZE
    const updated = await migration.migrate({
      items: currentItems,
      batchSize,
      yieldControl: yieldToEventLoop,
    })

    if (updated.length > 0) {
      const updatedMap = new Map(updated.map(i => [i.id, i]))
      const mergedItems: Item[] = []

      for (let index = 0; index < currentItems.length; index++) {
        const item = currentItems[index]
        mergedItems.push(updatedMap.get(item.id) || item)

        if ((index + 1) % batchSize === 0) {
          await yieldToEventLoop()
        }
      }

      currentItems = mergedItems
    }

    await yieldToEventLoop()
  }

  return currentItems
}
