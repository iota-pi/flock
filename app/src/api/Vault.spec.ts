import Vault from './Vault';
import { getAccountId, getItemId } from '../utils';
import store from '../store';
import { deleteItems, getBlankGroup, getBlankPerson, Item, setItems, updateItems } from '../state/items';
import { VaultItem } from './VaultAPI';
import { AccountMetadata, setAccount } from '../state/account';

function getVault(dispatch?: any) {
  const account = getAccountId();
  return Vault.create(
    account,
    'example',
    dispatch || store.dispatch,
    100,
  );
}

describe('Vault (Crypto)', () => {
  test('encrypt and decrypt', async () => {
    const vault = await getVault();
    const text = 'It came to me on my birthday, my precious.';
    const cipher = await vault.encrypt(text);
    const result = await vault.decrypt(cipher);
    expect(result).toEqual(text);
  });

  test('encryptObject and decryptObject', async () => {
    const vault = await getVault();
    const obj = { id: 'onering' };
    const cipher = await vault.encryptObject(obj);
    const result = await vault.decryptObject(cipher);
    expect(result).toEqual(obj);
  });

  test('import and export', async () => {
    const vault = await getVault();
    const text = 'It came to me on my birthday, my precious.';
    const cipher = await vault.encrypt(text);
    const exported = await vault.export();
    const imported = await Vault.import(exported, store.dispatch);
    const result = await imported.decrypt(cipher);
    expect(result).toEqual(text);
    expect(vault['account']).toEqual(imported['account']);
    expect(vault['keyHash']).toEqual(imported['keyHash']);
  });

  test('store a single item', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const api = { put: jest.fn() };
    vault['api'] = api as any;
    const item = getBlankPerson();

    await vault.store(item);

    expect(dispatch).toBeCalledWith(updateItems([item], true));
    const apiCallParams = api.put.mock.calls[0][0];
    expect(apiCallParams).toMatchObject({
      item: item.id,
      metadata: {
        type: item.type,
      },
    });
    expect(apiCallParams).toHaveProperty('cipher');
    expect(apiCallParams).toHaveProperty('metadata.iv');
  });

  test('store multiple items', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const api = { putMany: jest.fn() };
    vault['api'] = api as any;
    const items = [getBlankPerson(), getBlankGroup()];

    await vault.store(items);

    expect(dispatch).toBeCalledWith(updateItems(items, true));
    const apiCallParams = api.putMany.mock.calls[0][0];
    expect(apiCallParams).toMatchObject({});
    expect(apiCallParams.items.length).toEqual(items.length);
  });

  test('does not store items with missing properties', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const api = { put: jest.fn() };
    vault['api'] = api as any;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...item } = getBlankPerson();

    const promise = vault.store(item as Item);
    await expect(promise).rejects.toThrow();
  });

  test('does not store items with missing properties (putMany)', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const api = { putMany: jest.fn() };
    vault['api'] = api as any;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { description, ...partialItem } = getBlankPerson();
    const items = [getBlankPerson(), getBlankGroup(), partialItem as Item];

    const promise = vault.store(items);
    await expect(promise).rejects.toThrow();
  });

  test('fetchAll', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const original = [getBlankPerson(), getBlankGroup()];
    const encrypted = await Promise.all(original.map(item => vault.encryptObject(item)));
    const asAPIItems: VaultItem[] = encrypted.map((item, i) => ({
      account: vault['account'],
      cipher: item.cipher,
      item: original[i].id,
      metadata: {
        iv: item.iv,
        type: original[i].type,
        modified: new Date().getTime(),
      },
    }));
    const api = { fetchAll: jest.fn().mockReturnValue(asAPIItems) };
    vault['api'] = api as any;

    const result = await vault.fetchAll();

    expect(dispatch).toBeCalledWith(setItems(result));
    expect(result).toEqual(original);
  });

  test('delete a single item', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const api = { delete: jest.fn() };
    vault['api'] = api as any;
    const id = getItemId();

    await vault.delete(id);

    expect(dispatch).toBeCalledWith(deleteItems([id], true));
    const apiCallParams = api.delete.mock.calls[0][0];
    expect(apiCallParams).toMatchObject({
      item: id,
    });
  });

  test('delete multiple items', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const api = { deleteMany: jest.fn() };
    vault['api'] = api as any;
    const ids = [getItemId(), getItemId(), getItemId()];

    await vault.delete(ids);

    expect(dispatch).toBeCalledWith(deleteItems(ids, true));
    const apiCallParams = api.deleteMany.mock.calls[0][0];
    expect(apiCallParams).toMatchObject({
      items: ids,
    });
  });

  test('setMetadata', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const api = { setMetadata: jest.fn() };
    vault['api'] = api as any;
    const metadata: AccountMetadata = { prayerGoal: 1, completedMigrations: [] };

    await vault.setMetadata(metadata);

    expect(dispatch).toBeCalledWith(setAccount({ metadata }));
    const apiCallParams = api.setMetadata.mock.calls[0][0];
    expect(apiCallParams).toMatchObject({});
    const decrypted = await vault.decryptObject(apiCallParams.metadata);
    expect(decrypted).toMatchObject(metadata);
  });

  test('getMetadata encrypted', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] };
    const encrypted = await vault.encryptObject(original);
    const api = { getMetadata: jest.fn().mockReturnValue(encrypted) };
    vault['api'] = api as any;

    const result = await vault.getMetadata();

    expect(dispatch).toBeCalledWith(setAccount(result));
    expect(result.metadata).toEqual(original);
  });

  test('getMetadata plain', async () => {
    const dispatch = jest.fn();
    const vault = await getVault(dispatch);
    const original: AccountMetadata = { prayerGoal: 1, completedMigrations: ['foo'] };
    const api = { getMetadata: jest.fn().mockReturnValue(original) };
    vault['api'] = api as any;

    const result = await vault.getMetadata();

    expect(dispatch).toBeCalledWith(setAccount(result));
    expect(result.metadata).toEqual(original);
  });
});
