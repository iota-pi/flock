import DynamoDriver, { getConnectionParams } from './dynamo'
import { generateItemId } from '../../utils'
import { generateAccountId } from '../util'
import type { ItemType } from 'src/shared/itemTypes'

const driver = new DynamoDriver()
describe('DynamoDriver', function () {
  beforeAll(function () {
    driver.connect(getConnectionParams())
  })

  it('set, get, delete', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
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
    const type: ItemType = 'person'
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

  it('set injects ttl for tombstones', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
    const modified = new Date().getTime()

    await driver.set({
      account,
      item,
      cipher: 'tombstone-cipher',
      metadata: {
        type,
        iv: 'tombstone-iv',
        modified,
        deleted: true,
      },
    })

    const result = await driver.get({ account, item: item })
    expect(result.metadata.deleted).toBe(true)
    expect(typeof result.ttl).toBe('number')
  })

  it('set rejects oversized items', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
    const modified = new Date().getTime()
    const cipher = 'x'.repeat(60000)

    await expect(
      driver.set({ account, item, cipher, metadata: { type, iv: 'iv', modified } })
    ).rejects.toThrow('exceeds maximum')
  })

  it('fetchAll works', async () => {
    const account = generateAccountId()
    const individuals = []
    const type: ItemType = 'person'
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
  const iterations = 100_000
  const session = 'an_example_session_token_for_testing'

  it('createAccount works as expected', async () => {
    const account = generateAccountId()
    const success = await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
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
      iterations,
      session,
    })

    expect(
      await driver.checkSession({ account, session: authToken, isLogin: true })
    ).toEqual({ success: true })
    expect(
      await driver.checkSession({ account, session: authToken, isLogin: false })
    ).toEqual({ success: false, reason: 'expired' })
    expect(
      await driver.checkSession({ account, session: authToken })
    ).toEqual({ success: false, reason: 'expired' })
  })

  it('checkSession works based on session', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
      session,
    })

    const newSession = 'a_new_session_token'
    await driver.updateAccountData({
      account,
      session: newSession,
    })
    expect(
      await driver.checkSession({ account, session })
    ).toMatchObject({ success: false, reason: 'expired' })
    expect(
      await driver.checkSession({ account, session: authToken })
    ).toMatchObject({ success: false, reason: 'expired' })
    expect(
      await driver.checkSession({ account, session: newSession })
    ).toMatchObject({ success: true })
    expect(
      await driver.checkSession({ account, session: 'wrong' })
    ).toMatchObject({ success: false, reason: 'expired' })
    expect(
      await driver.checkSession({ account, session: '' })
    ).toMatchObject({ success: false })
  })

  it('checkSession accepts multiple active sessions', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
      session,
    })

    const sessionA = 'session-A'
    const sessionB = 'session-B'
    const expiry = Date.now() + 60_000

    await driver.updateAccountData({
      account,
      session: sessionB,
      sessions: [
        { token: sessionA, expiry },
        { token: sessionB, expiry },
      ],
    })

    expect(await driver.checkSession({ account, session: sessionA })).toMatchObject({ success: true })
    expect(await driver.checkSession({ account, session: sessionB })).toMatchObject({ success: true })
  })

  it('repeated createAccount calls fail', async () => {
    const account = generateAccountId()
    const params = { account, authToken, metadata, salt, iterations, session }
    const result1 = await driver.createAccount(params)
    expect(result1).toBe(true)
    const result2 = await driver.createAccount(params)
    expect(result2).toBe(false)
    const result3 = await driver.createAccount(params)
    expect(result3).toBe(false)
  })

  it('extendSession updates sessionExpiry', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
      session,
    })

    // Session should be valid after creation
    expect(
      await driver.checkSession({ account, session })
    ).toEqual({ success: true })

    // Extend the session
    await driver.extendSession({ account })

    // Session should still be valid after extension
    expect(
      await driver.checkSession({ account, session })
    ).toEqual({ success: true })
  })

  it('normalizes sessions when updating account data', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
      session,
    })

    const now = Date.now()
    const sessions = Array.from({ length: 9 }, (_, i) => ({
      token: `session-${i + 1}`,
      expiry: now + (i + 1) * 1000,
    }))

    await driver.updateAccountData({
      account,
      sessions: [
        { token: 'expired', expiry: now - 1000 },
        ...sessions,
        { token: 'session-3', expiry: now + 5000 },
      ],
    })

    const result = await driver.getAccount({ account, session: 'session-9' })
    const tokens = result.sessions?.map(entry => entry.token) ?? []

    expect(tokens.length).toBe(8)
    expect(tokens).toContain('session-9')
    expect(tokens).not.toContain('session-1')
  })

  it('can save and retrieve keyring', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
      session,
    })

    const keyringValue = 'encrypted_keyring_payload_sample'
    await driver.updateAccountData({
      account,
      keyring: keyringValue,
    })

    const result = await driver.getAccount({ account, session })
    expect(result.keyring).toBe(keyringValue)
  })
})
