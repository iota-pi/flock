import Vault from '../../api/Vault';
import store from '../../store';
import { Item, ItemNoteType } from '../items';

export interface ItemMigration {
  dependencies: string[],
  description?: string,
  id: string,
  migrate: (args: { items: Item[], vault: Vault }) => Promise<boolean>,
}

const migrations: ItemMigration[] = [
  {
    dependencies: [],
    id: 'migrate-prayer-points-to-notes',
    description: 'Deprecating prayer-points feature; just use the notes field instead',
    migrate: async ({ items, vault }) => {
      let success = true;
      const updatedItems: Item[] = [];
      for (const item of items) {
        try {
          const prayerPoints = item.notes.filter(
            n => (n.type as ItemNoteType | 'prayer') === 'prayer',
          );
          if (prayerPoints.length > 0) {
            const otherNotes = item.notes.filter(
              n => (n.type as ItemNoteType | 'prayer') !== 'prayer',
            );
            const prayerPointString = prayerPoints.map(p => `* ${p.content}`).join('\n');
            updatedItems.push({
              ...item,
              notes: otherNotes,
              summary: [
                item.summary,
                `Prayer points:\n${prayerPointString}`,
              ].filter(s => s).join('\n\n'),
            });
          }
        } catch (error) {
          console.error(error);
          success = false;
        }
      }
      if (updatedItems.length > 0) {
        await vault.store(updatedItems);
      }
      console.log(`Updated ${updatedItems.length} items`);
      return success;
    },
  },
];

async function migrateItems(items: Item[]) {
  // Reverse migrations to reduce dependency conflicts
  // (assuming new migrations are added to the top of the array)
  const reversedMigrations = migrations.slice().reverse();
  const { metadata, vault } = store.getState();
  const previousMigrations = (metadata.completedMigrations as string[]) || [];
  const completedMigrations = previousMigrations.slice();
  if (!vault) {
    console.warn('Vault not initialised, skipping migrations');
    return previousMigrations;
  }

  let ranMigrations = true;
  while (ranMigrations) {
    ranMigrations = false;

    for (const migration of reversedMigrations) {
      if (completedMigrations.includes(migration.id)) {
        continue;
      }

      const missingDeps: string[] = [];
      for (const dep of migration.dependencies) {
        if (!completedMigrations.includes(dep)) {
          missingDeps.push(dep);
        }
      }
      if (missingDeps.length > 0) {
        console.info(
          `Skipping migration: ${migration.id}\n`,
          `Dependencies not yet satisfied: ${missingDeps.join(', ')}`,
        );
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const successful = await migration.migrate({ items, vault });
        if (successful) {
          ranMigrations = true;
          completedMigrations.push(migration.id);
        }
      } catch (error) {
        console.warn('Uncaught error in migration');
        console.error(error);
      }
    }
  }

  if (previousMigrations.length !== completedMigrations.length) {
    await vault.setMetadata({ ...metadata, completedMigrations });
    vault.clearItemCache();
  }
  return completedMigrations;
}

export default migrateItems;
