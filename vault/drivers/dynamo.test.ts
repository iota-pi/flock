import DynamoDriver, { getConnectionParams } from './dynamo';
import { getAccountId, getItemId } from '../../app/src/utils';
import { VaultItemType } from './base';

async function stringToPromise(s: string): Promise<string> {
  return s;
}

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
    const account = getAccountId();
    const authToken = stringToPromise('an_example_auth_token_for_testing');
    const success = await driver.createAccount({ account, authToken });
    expect(success).toBe(true);

    expect(await driver.checkPassword({ account, authToken })).toBe(true);
    expect(
      await driver.checkPassword({ account, authToken: stringToPromise('') })
    ).toBe(false);
    expect(
      await driver.checkPassword({ account, authToken: stringToPromise(authToken + 'a') })
    ).toBe(false);
  });

  it('repeated createAccount calls fail', async () => {
    const account = getAccountId();
    const authToken = stringToPromise('an_example_auth_token_for_testing');
    const result1 = await driver.createAccount({ account, authToken });
    expect(result1).toBe(true);
    const result2 = await driver.createAccount({ account, authToken });
    expect(result2).toBe(false);
    const result3 = await driver.createAccount({ account, authToken });
    expect(result3).toBe(false);
  });
});
