import store from '../store';
import { getBlankGroup, getBlankPerson, Item } from '../state/items';
import * as vault from './Vault';
import * as common from './common';
import * as api from './VaultAPI';
import type { VaultItem } from './VaultAPI';

describe('Vault (Crypto)', () => {
  beforeAll(
    async () => {
      jest.spyOn(vault, 'storeVault').mockImplementation(() => Promise.resolve());
      jest.spyOn(vault, 'loadVault').mockImplementation(() => Promise.resolve());

      jest.spyOn(vault, 'getItemCacheTime').mockImplementation(() => null);
      jest.spyOn(vault, 'mergeWithItemCache').mockImplementation(() => Promise.resolve([]));
      jest.spyOn(vault, 'setItemCache').mockImplementation(() => {});
      jest.spyOn(vault, 'clearItemCache').mockImplementation(() => {});
      jest.spyOn(vault, 'checkItemCache').mockReturnValue(false);
      jest.spyOn(common, 'getAxios').mockImplementation(() => ({
        put: jest.fn(() => ({ data: { success: true } })),
      }) as any);

      await vault.initialiseVault(
        'example',
        true,
        100,
      );
    },
    10000,
  );

  test('encrypt and decrypt', async () => {
    const text = 'It came to me on my birthday, my precious.';
    const cipher = await vault.encrypt(text);
    const result = await vault.decrypt(cipher);
    expect(result).toEqual(text);
  });

  test('encryptObject and decryptObject', async () => {
    const obj = { id: 'onering' };
    const cipher = await vault.encryptObject(obj);
    const result = await vault.decryptObject(cipher);
    expect(result).toEqual(obj);
  });

  test('store a single item', async () => {
    const item = getBlankPerson();
    await vault.storeItems(item);
    expect(store.getState().items.ids).toContain(item.id);
  });

  test('store multiple items', async () => {
    const items = [getBlankPerson(), getBlankGroup()];
    await vault.storeItems(items);
    expect(store.getState().items.ids).toContain(items[0].id);
    expect(store.getState().items.ids).toContain(items[1].id);
  });

  test('does not store items with missing properties (single)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...item } = getBlankPerson();
    await expect(vault.storeItems(item as Item)).rejects.toThrow();
  });

  test('does not store items with missing properties (many)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...partialItem } = getBlankPerson();
    const items = [getBlankPerson(), getBlankGroup(), partialItem as Item];

    const promise = vault.storeItems(items);
    await expect(promise).rejects.toThrow();
  });

  test('fetchAll', async () => {
    const original = [getBlankPerson(), getBlankGroup()];
    const encrypted = await Promise.all(original.map(item => vault.encryptObject(item)));
    const asAPIItems: VaultItem[] = encrypted.map((item, i) => ({
      account: '',
      cipher: item.cipher,
      item: original[i].id,
      metadata: {
        iv: item.iv,
        type: original[i].type,
        modified: new Date().getTime(),
      },
    }));

    jest.spyOn(api, 'vaultFetchAll').mockReturnValue(Promise.resolve(asAPIItems));

    const result = await vault.fetchAll();
    expect(result).toEqual(original);
  });

  // test('delete a single item', async () => {
  //   const api = { delete: jest.fn() };
  //   vault['api'] = api as any;
  //   const id = generateItemId();

  //   await vault.delete(id);

  //   expect(dispatch).toHaveBeenCalledWith(deleteItems([id], true));
  //   const apiCallParams = api.delete.mock.calls[0][0];
  //   expect(apiCallParams).toMatchObject({
  //     item: id,
  //   });
  // });

  // test('delete multiple items', async () => {
  //   const vault = await getVault(dispatch);
  //   const api = { deleteMany: jest.fn() };
  //   vault['api'] = api as any;
  //   const ids = [generateItemId(), generateItemId(), generateItemId()];

  //   await vault.delete(ids);

  //   expect(dispatch).toHaveBeenCalledWith(deleteItems(ids, true));
  //   const apiCallParams = api.deleteMany.mock.calls[0][0];
  //   expect(apiCallParams).toMatchObject({
  //     items: ids,
  //   });
  // });

  // test('setMetadata', async () => {
  //   const vault = await getVault(dispatch);
  //   const api = { setMetadata: jest.fn() };
  //   vault['api'] = api as any;
  //   const metadata: AccountMetadata = { prayerGoal: 1, completedMigrations: [] };

  //   await vault.setMetadata(metadata);

  //   expect(dispatch).toHaveBeenCalledWith(setAccount({ metadata }));
  //   const apiCallParams = api.setMetadata.mock.calls[0][0];
  //   expect(apiCallParams).toMatchObject({});
  //   const decrypted = await vault.decryptObject(apiCallParams.metadata);
  //   expect(decrypted).toMatchObject(metadata);
  // });

  // test('getMetadata encrypted', async () => {
  //   const vault = await getVault(dispatch);
  //   const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] };
  //   const encrypted = await vault.encryptObject(original);
  //   const api = { getMetadata: jest.fn().mockReturnValue(encrypted) };
  //   vault['api'] = api as any;

  //   const result = await vault.getMetadata();

  //   expect(dispatch).toHaveBeenCalledWith(setAccount(result));
  //   expect(result.metadata).toEqual(original);
  // });

  // test('getMetadata plain', async () => {
  //   const vault = await getVault(dispatch);
  //   const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] };
  //   const api = { getMetadata: jest.fn().mockReturnValue(original) };
  //   vault['api'] = api as any;

  //   const result = await vault.getMetadata();

  //   expect(dispatch).toHaveBeenCalledWith(setAccount(result));
  //   expect(result.metadata).toEqual(original);
  // });
});
