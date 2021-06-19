import Vault from '../../crypto/Vault';
import store from '../../store';
import { updateMetadata } from '../account';
import { GeneralItem, Item, updateItems } from '../items';

const dispatch = store.dispatch;

export interface ItemMigration {
  dependencies: string[],
  description?: string,
  id: string,
  migrate: (args: { items: Item[], vault: Vault }) => Promise<boolean>,
}

const migrations: ItemMigration[] = [
  {
    dependencies: [],
    id: 'mergeEventsAndPlaces',
    migrate: async ({ items, vault }) => {
      let successful = true;

      for (let i = 0; i < items.length; ++i) {
        try {
          if (['event', 'place'].includes(items[i].type as string)) {
            const newItem: GeneralItem = { ...items[i] as GeneralItem, type: 'general' };
            dispatch(updateItems([
              { ...items[i] as GeneralItem, type: 'general' },
            ]));
            vault.store(newItem);
          }
        } catch (error) {
          console.error(error);
          successful = false;
        }
      }

      return successful;
    },
  },
];

async function migrateItems(items: Item[]) {
  // Reverse migrations to reduce dependency conflicts
  // (assuming new migrations are added to the top of the array)
  const reversedMigrations = migrations.slice().reverse();
  const { account, metadata, vault } = store.getState();
  const previousMigrations: string[] = metadata.completedMigrations || [];
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
      // eslint-disable-next-line no-await-in-loop
      const successful = await migration.migrate({ items, vault });
      if (successful) {
        ranMigrations = true;
        completedMigrations.push(migration.id);
        // console.info(`Completed migration: ${migration.id}`);
      }
    }
  }

  if (previousMigrations.length !== completedMigrations.length) {
    await updateMetadata({
      account,
      dispatch,
      metadata: { ...metadata, completedMigrations },
      vault,
    });
  }
  return completedMigrations;
}

export default migrateItems;
