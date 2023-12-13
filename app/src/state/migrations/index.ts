import { clearItemCache, setMetadata } from '../../api/Vault';
import store from '../../store';
import { Item } from '../items';

export interface ItemMigration {
  dependencies: string[],
  description?: string,
  id: string,
  migrate: (args: { items: Item[] }) => Promise<boolean>,
}

const migrations: ItemMigration[] = [
];

async function migrateItems(items: Item[]) {
  // Reverse migrations to reduce dependency conflicts
  // (assuming new migrations are added to the top of the array)
  const reversedMigrations = migrations.slice().reverse();
  const metadata = store.getState().account.metadata;
  const previousMigrations = (metadata.completedMigrations as string[]) || [];
  const completedMigrations = previousMigrations.slice();

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
        const successful = await migration.migrate({ items });
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
    await setMetadata({ ...metadata, completedMigrations });
    clearItemCache();
  }
  return completedMigrations;
}

export default migrateItems;
