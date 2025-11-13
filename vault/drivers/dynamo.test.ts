import DynamoDriver, { getConnectionParams } from './dynamo'
import { generateItemId } from '../../app/src/utils'
import { VaultItemType } from './base'
import { generateAccountId } from '../util'

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

  const authToken = 'an_example_auth_token_for_testing'
  const metadata = {}
  const salt = 'an_example_salt_for_testing'
  const session = 'an_example_session_token_for_testing'

  it('createAccount works as expected', async () => {
    const account = generateAccountId()
    const success = await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      session,
    })
    expect(success).toBe(true)
  })

  it('login works based on authToken', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      session,
    })

    expect(
      await driver.checkSession({ account, session: authToken, isLogin: true })
    ).toBe(true)
    expect(
      await driver.checkSession({ account, session: authToken, isLogin: false })
    ).toBe(false)
    expect(
      await driver.checkSession({ account, session: authToken })
    ).toBe(false)
  })

  it('checkSession works based on session', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      session,
    })

    const newSession = 'a_new_session_token'
    await driver.updateAccountData({
      account,
      session: newSession,
    })
    expect(
      await driver.checkSession({ account, session })
    ).toBe(false)
    expect(
      await driver.checkSession({ account, session: authToken })
    ).toBe(false)
    expect(
      await driver.checkSession({ account, session: newSession })
    ).toBe(true)
    expect(
      await driver.checkSession({ account, session: 'wrong' })
    ).toBe(false)
    expect(
      await driver.checkSession({ account, session: '' })
    ).toBe(false)
  })

  it('repeated createAccount calls fail', async () => {
    const account = generateAccountId()
    const params = { account, authToken, metadata, salt, session }
    const result1 = await driver.createAccount(params)
    expect(result1).toBe(true)
    const result2 = await driver.createAccount(params)
    expect(result2).toBe(false)
    const result3 = await driver.createAccount(params)
    expect(result3).toBe(false)
  })
})
