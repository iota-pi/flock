import { Item, convertItem } from '../items'
import {
  convertLegacyTagsToGroups,
  mergeLegacyPersonNames,
  migrateSummaryToNotes,
  type MigrationYieldContext,
} from './transforms'

export interface ItemMigration {
  batchSize?: number,
  description?: string,
  id: string,
  migrate: (args: { items: Item[] } & MigrationYieldContext) => Promise<Item[]>,
}

export const migrations: ItemMigration[] = [
  {
    description: 'Delete empty summaries',
    id: 'delete-empty-summaries',
    migrate: async ({ items, batchSize, yieldControl }) => {
      const updatedItems: Item[] = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index] as Item & { summary?: string }
        if (item.summary === '') {
          delete item.summary
          updatedItems.push(item)
        }

        if ((index + 1) % batchSize === 0) {
          await yieldControl()
        }
      }
      return updatedItems
    },
  },
  {
    description: 'Migrate summary to notes',
    id: 'migrate-summary-to-notes',
    batchSize: 150,
    migrate: async ({ items, batchSize, yieldControl }) => migrateSummaryToNotes(items, { batchSize, yieldControl }),
  },
  {
    description: 'Remove legacy tags property',
    id: 'remove-legacy-tags',
    migrate: async ({ items, batchSize, yieldControl }) => {
      const updatedItems: Item[] = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index] as Item & { tags?: string[] }
        if (item.tags) {
          delete item.tags
          updatedItems.push(item)
        }

        if ((index + 1) % batchSize === 0) {
          await yieldControl()
        }
      }
      return updatedItems
    },
  },
  {
    description: 'Convert tags to groups',
    id: 'convert-tags-to-groups',
    batchSize: 150,
    migrate: async ({ items, batchSize, yieldControl }) => convertLegacyTagsToGroups(items, { batchSize, yieldControl }),
  },
  {
    description: 'Convert general items to people',
    id: 'convert-general-to-person-2',
    migrate: async ({ items, batchSize, yieldControl }) => {
      const updatedItems: typeof items = []
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        if ((item.type as string) === 'general') {
          updatedItems.push(convertItem(item, 'person'))
        }

        if ((index + 1) % batchSize === 0) {
          await yieldControl()
        }
      }
      return updatedItems
    },
  },
  {
    description: 'Merge first and last names for people',
    id: 'merge-people-names-2',
    batchSize: 200,
    migrate: async ({ items, batchSize, yieldControl }) => mergeLegacyPersonNames(items, { batchSize, yieldControl }),
  },
  {
    description: 'Initialize item version',
    id: 'add-version-to-items',
    migrate: async ({ items }) => {
      // Return all items to force a save with version 1 (set by supplyMissingAttributes)
      return [...items]
    },
  },
  {
    description: 'Rewrite all items as branch envelopes',
    id: 'rewrite-items-as-branches-2026-03',
    migrate: async ({ items }) => {
      // One-time sweep: mutateStoreItems will serialize each item to branch format.
      // This migrates cold legacy cipher-only rows without requiring manual edits.
      return [...items]
    },
  },
]
