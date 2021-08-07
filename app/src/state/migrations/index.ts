import Vault from '../../crypto/Vault';
import store from '../../store';
import { Item } from '../items';

export interface ItemMigration {
  dependencies: string[],
  description?: string,
  id: string,
  migrate: (args: { items: Item[], vault: Vault }) => Promise<boolean>,
}

const migrations: ItemMigration[] = [
];

async function migrateItems(items: Item[]) {
  // Reverse migrations to reduce dependency conflicts
  // (assuming new migrations are added to the top of the array)
  const reversedMigrations = migrations.slice().reverse();
  const { metadata, vault } = store.getState();
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
      }
    }
  }

  if (previousMigrations.length !== completedMigrations.length) {
    await vault.setMetadata({ ...metadata, completedMigrations });
  }
  return completedMigrations;
}

export default migrateItems;
