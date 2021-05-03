import DynamoDriver, { getConnectionParams } from './dynamo';
import { getAccountId, getItemId } from '../../app/src/utils';
import { VaultItemType } from './base';

const driver = new DynamoDriver();
describe('DynamoDriver', function () {
  beforeAll(function () {
    driver.connect(getConnectionParams());
  });

  it('set, get, delete', async () => {
    const account = getAccountId();
    const item = getItemId();
    const type: VaultItemType = 'person';
    const cipher = 'hello';
    const iv = 'there';

    await driver.set({ account, item, cipher, metadata: { type, iv } });
    const result = await driver.get({ account, item });
    expect(result).toEqual({ cipher, metadata: { type, iv } });

    await driver.delete({ account, item });
    const p = driver.get({ account, item });
    await expect(p).rejects.toThrow();
  });

  it('set can create and update', async () => {
    const account = getAccountId();
    const item = getItemId();
    const type: VaultItemType = 'person';
    let cipher = 'hello';
    let iv = 'there';

    await driver.set({ account, item, cipher, metadata: { type, iv } });
    cipher = 'good';
    iv = 'bye';
    await driver.set({ account, item, cipher, metadata: { type, iv } });
    const result = await driver.get({ account, item });
    expect(result).toEqual({ cipher, metadata: { type, iv } });
  });

  it('fetchAll works', async () => {
    const account = getAccountId();
    const individuals = [];
    const type: VaultItemType = 'person';
    const cipher = 'hello';
    const iv = 'there';
    for (let i = 0; i < 10; ++i) {
      const item = getItemId();
      individuals.push(item);
      await driver.set({ account, item, cipher, metadata: { type, iv } });
    }
    const result = await driver.fetchAll({ account });
    expect(result.length).toEqual(10);
  });

  it('createAccount and checkPassword', async () => {
    const authToken = 'q89gvlsuh398hflauht389yfles';
    const account = await driver.createAccount({ authToken });
    expect(typeof account).toEqual('string');
    expect(account.length).toBeGreaterThan(0);

    expect(await driver.checkPassword({ account, authToken })).toBe(true);
    expect(await driver.checkPassword({ account, authToken: '' })).toBe(false);
    expect(await driver.checkPassword({ account, authToken: authToken + 'a' })).toBe(false);
  });
});
