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

  const tempAuthToken = 'temp_auth_token'
  const authToken = 'an_example_auth_token_for_testing'
  const metadata = {}
  const salt = 'an_example_salt_for_testing'
  const session = ''

  it('createAccount works as expected', async () => {
    const account = generateAccountId()
    const success = await driver.createAccount({
      account,
      authToken: tempAuthToken,
      metadata,
      salt,
      session,
    })
    expect(success).toBe(true)
  })

  it('checkPassword works based on authToken', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken: tempAuthToken,
      metadata,
      salt,
      session,
    })

    await driver.updateAccountData({
      account,
      authToken,
      tempAuthToken,
    })

    expect(await driver.checkPassword({ account, authToken, session: '' })).toBe(true)
    expect(
      await driver.checkPassword({ account, authToken: tempAuthToken, session: '' })
    ).toBe(false)
    expect(
      await driver.checkPassword({ account, authToken: '', session: '' })
    ).toBe(false)
    expect(
      await driver.checkPassword({
        account,
        authToken: authToken + 'a',
        session: '',
      })
    ).toBe(false)
  })

  it('checkPassword works based on session', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken: tempAuthToken,
      metadata,
      salt,
      session,
    })

    await driver.updateAccountData({
      account,
      authToken,
      tempAuthToken,
    })

    const newSession = 'a_new_session_token'
    await driver.updateAccountData({
      account,
      session: newSession,
    })
    expect(
      await driver.checkPassword({ account, authToken, session: newSession })
    ).toBe(true)
    expect(
      await driver.checkPassword({ account, authToken: 'wrong', session: newSession })
    ).toBe(true)
    expect(
      await driver.checkPassword({ account, authToken: 'wrong', session: 'wrong' })
    ).toBe(false)
  })

  it('tempAuthToken cannot be used twice', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken: tempAuthToken,
      metadata,
      salt,
      session,
    })

    // First attempt should succeed
    await driver.updateAccountData({
      account,
      authToken,
      tempAuthToken,
    })
    await expect(
      driver.checkPassword({ account, authToken, session: '' })
    ).resolves.toBe(true)
    await expect(
      driver.checkPassword({ account, authToken: tempAuthToken, session: '' })
    ).resolves.toBe(false)

    // Second attempt to use tempAuthToken should fail
    await expect(
      driver.updateAccountData({
        account,
        authToken: 'another_auth_token',
        tempAuthToken,
      })
    ).rejects.toThrow()
    await expect(
      driver.checkPassword({ account, authToken, session: '' })
    ).resolves.toBe(true)
    await expect(
      driver.checkPassword({ account, authToken: tempAuthToken, session: '' })
    ).resolves.toBe(false)
  })

  it('repeated createAccount calls fail', async () => {
    const account = generateAccountId()
    const authToken = 'an_example_auth_token_for_testing'
    const metadata = {}
    const salt = 'an_example_salt_for_testing'
    const session = ''
    const result1 = await driver.createAccount({ account, authToken, metadata, salt, session })
    expect(result1).toBe(true)
    const result2 = await driver.createAccount({ account, authToken, metadata, salt, session })
    expect(result2).toBe(false)
    const result3 = await driver.createAccount({ account, authToken, metadata, salt, session })
    expect(result3).toBe(false)
  })
})
