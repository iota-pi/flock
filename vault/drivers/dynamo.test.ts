import DynamoDriver, { getConnectionParams } from './dynamo'
import { generateAccountId, generateItemId } from '../../app/src/utils'
import { VaultItemType } from './base'

async function stringToPromise(s: string): Promise<string> {
  return s
}

const driver = new DynamoDriver()
describe('DynamoDriver', function () {
  beforeAll(function () {
    driver.connect(getConnectionParams())
  })

  it('set, get, delete', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: VaultItemType = 'person'
    const cipher = 'hello'
    const iv = 'there'
    const modified = new Date().getTime()

    await driver.set({ account, item, cipher, metadata: { type, iv, modified } })
    const result = await driver.get({ account, item })
    expect(result).toEqual({ cipher, metadata: { type, iv, modified } })

    await driver.delete({ account, item })
    const p = driver.get({ account, item })
    await expect(p).rejects.toThrow()
  })

  it('set can create and update', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: VaultItemType = 'person'
    let cipher = 'hello'
    let iv = 'there'
    const modified = new Date().getTime()

    await driver.set({ account, item, cipher, metadata: { type, iv, modified } })
    cipher = 'good'
    iv = 'bye'
    await driver.set({ account, item, cipher, metadata: { type, iv, modified } })
    const result = await driver.get({ account, item })
    expect(result).toEqual({ cipher, metadata: { type, iv, modified } })
  })

  it('fetchAll works', async () => {
    const account = generateAccountId()
    const individuals = []
    const type: VaultItemType = 'person'
    const cipher = 'hello'
    const iv = 'there'
    const modified = new Date().getTime()
    for (let i = 0; i < 10; ++i) {
      const item = generateItemId()
      individuals.push(item)
      await driver.set({ account, item, cipher, metadata: { type, iv, modified } })
    }
    const result = await driver.fetchAll({ account })
    expect(result.length).toEqual(10)
  })

  it('createAccount and checkPassword', async () => {
    const account = generateAccountId()
    const authToken = stringToPromise('an_example_auth_token_for_testing')
    const success = await driver.createAccount({ account, authToken })
    expect(success).toBe(true)

    expect(await driver.checkPassword({ account, authToken })).toBe(true)
    expect(
      await driver.checkPassword({ account, authToken: stringToPromise('') })
    ).toBe(false)
    expect(
      await driver.checkPassword({ account, authToken: stringToPromise(authToken + 'a') })
    ).toBe(false)
  })

  it('repeated createAccount calls fail', async () => {
    const account = generateAccountId()
    const authToken = stringToPromise('an_example_auth_token_for_testing')
    const result1 = await driver.createAccount({ account, authToken })
    expect(result1).toBe(true)
    const result2 = await driver.createAccount({ account, authToken })
    expect(result2).toBe(false)
    const result3 = await driver.createAccount({ account, authToken })
    expect(result3).toBe(false)
  })
})
