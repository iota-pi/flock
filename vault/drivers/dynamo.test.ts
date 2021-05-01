import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import DynamoDriver, { getConnectionParams } from './dynamo';
import { getAccountId, getIndividualId } from '../../app/src/utils';
chai.use(chaiAsPromised);

const driver = new DynamoDriver();
describe('DynamoDriver', function () {
  before(async function () {
    await driver.connect(getConnectionParams());
  });

  it('set, get, delete', async () => {
    const account = getAccountId();
    const individual = getIndividualId();
    const cipher = 'hello';
    const iv = 'there';

    await driver.set({ account, individual, cipher, iv });
    const result = await driver.get({ account, individual });
    expect(result).to.deep.equal({ cipher, iv });

    await driver.delete({ account, individual });
    const p = driver.get({ account, individual });
    await expect(p).to.be.rejected;
  });

  it('set can create and update', async () => {
    const account = getAccountId();
    const individual = getIndividualId();
    let cipher = 'hello';
    let iv = 'there';

    await driver.set({ account, individual, cipher, iv });
    cipher = 'good';
    iv = 'bye';
    await driver.set({ account, individual, cipher, iv });
    const result = await driver.get({ account, individual });
    expect(result).to.deep.equal({ cipher, iv });
  });

  it('fetchAll works', async () => {
    const account = getAccountId();
    const individuals = [];
    const cipher = 'hello';
    const iv = 'there';
    for (let i = 0; i < 10; ++i) {
      const individual = getIndividualId();
      individuals.push(individual);
      await driver.set({ account, individual, cipher, iv });
    }
    const result = await driver.fetchAll({ account });
    expect(result.length).to.equal(10);
  });
});
