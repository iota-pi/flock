import DynamoDriver, { getConnectionParams } from './dynamo'
import { generateItemId } from '../../utils'
import { generateAccountId } from '../util'
import type { ItemType } from 'src/shared/itemTypes'
import { ItemId } from 'src/shared/schemas/items'

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
    })

    const newSession = 'a_new_session_token'
    const expiry = Date.now() + 60_000
    await driver.updateAccountData({
      account,
      sessions: [{ token: newSession, expiry }],
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
    })

    const sessionA = 'session-A'
    const sessionB = 'session-B'
    const expiry = Date.now() + 60_000

    await driver.updateAccountData({
      account,
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
    const params = { account, authToken, metadata, salt, iterations }
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
    })

    const sessionA = 'session-A'
    const expiry = Date.now() + 1000 // 1 second expiry
    await driver.updateAccountData({
      account,
      sessions: [{ token: sessionA, expiry }]
    })

    // Session should be valid after creation
    expect(
      await driver.checkSession({ account, session: sessionA })
    ).toEqual({ success: true })

    // Extend the session
    await driver.extendSession({ account, session: sessionA })

    // Check the updated expiry in getAccount
    const acc = await driver.getAccount({ account, session: sessionA })
    const updatedSession = acc.sessions?.find(s => s.token === sessionA)
    expect(updatedSession?.expiry).toBeGreaterThan(Date.now() + 10000)
  })

  it('normalizes sessions when updating account data', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
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
    })

    const testSession = 'session-keyring-test'
    await driver.updateAccountData({
      account,
      sessions: [{ token: testSession, expiry: Date.now() + 60_000 }]
    })

    const keyringValue = 'encrypted_keyring_payload_sample'
    await driver.updateAccountData({
      account,
      keyring: keyringValue,
    })

    const result = await driver.getAccount({ account, session: testSession })
    expect(result.keyring).toBe(keyringValue)
  })

  it('can append, push, and get sync messages', async () => {
    const account = generateAccountId()
    const itemId = 'test-item-123' as ItemId
    const entry1 = {
      cursor: 1001,
      encryptedMessage: { iv: 'iv1', cipher: 'cipher1' },
      createdAt: Date.now(),
    }
    const entry2 = {
      cursor: 1002,
      encryptedMessage: { iv: 'iv2', cipher: 'cipher2' },
      createdAt: Date.now(),
    }

    await driver.appendSyncMessage({ account, itemId, entry: entry1 })
    await driver.pushSyncMessagesBatch({
      account,
      messages: [
        { itemId, entry: entry2, lastModified: Date.now() },
      ],
    })

    const result = await driver.getSyncMessages({ account, itemId })
    expect(result.messages.length).toBe(2)
    const sorted = result.messages.sort((a, b) => a.cursor - b.cursor)
    expect(sorted[0].cursor).toBe(1001)
    expect(sorted[1].cursor).toBe(1002)
  })

  it('session eviction on updateAccountData works', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
      iterations,
    })

    const sessionA = 'session-A'
    const sessionB = 'session-B'
    const expiry = Date.now() + 60_000

    await driver.updateAccountData({
      account,
      sessions: [
        { token: sessionA, expiry },
        { token: sessionB, expiry },
      ],
    })

    // Both sessions are valid
    expect(await driver.checkSession({ account, session: sessionA })).toMatchObject({ success: true })
    expect(await driver.checkSession({ account, session: sessionB })).toMatchObject({ success: true })

    // Simulate changePassword by updating sessions array to only contain sessionA
    await driver.updateAccountData({
      account,
      sessions: [{ token: sessionA, expiry }],
    })

    // Now sessionA is valid, sessionB is revoked
    expect(await driver.checkSession({ account, session: sessionA })).toMatchObject({ success: true })
    expect(await driver.checkSession({ account, session: sessionB })).toMatchObject({ success: false, reason: 'expired' })
  })

  it('fetchManifest returns item and modifiedAt tuples without payload', async () => {
    const account = generateAccountId()
    const type: ItemType = 'person'
    const cipher = 'test-cipher'
    const iv = 'test-iv'
    const modified = 1234567890

    const item1 = generateItemId()
    const item2 = generateItemId()

    await driver.set({ account, item: item1, cipher, metadata: { type, iv, modified } })
    await driver.set({ account, item: item2, cipher, metadata: { type, iv, modified: modified + 100 } })

    const manifest = await driver.fetchManifest({ account })
    expect(manifest.length).toBe(2)

    const ids = manifest.map(m => m.itemId)
    expect(ids).toContain(item1)
    expect(ids).toContain(item2)

    const entry1 = manifest.find(m => m.itemId === item1)
    expect(entry1?.modifiedAt).toBe(modified)
  })

  it('fetchByIds retrieves exact items in batches', async () => {
    const account = generateAccountId()
    const type: ItemType = 'person'
    const cipher = 'targeted-cipher'
    const iv = 'targeted-iv'

    const item1 = generateItemId()
    const item2 = generateItemId()
    const item3 = generateItemId()

    await driver.set({ account, item: item1, cipher, metadata: { type, iv, modified: 100 } })
    await driver.set({ account, item: item2, cipher, metadata: { type, iv, modified: 200 } })
    await driver.set({ account, item: item3, cipher, metadata: { type, iv, modified: 300 } })

    const result = await driver.fetchByIds({ account, itemIds: [item1, item3] })
    expect(result.length).toBe(2)
    const fetchedIds = result.map(r => r.item)
    expect(fetchedIds).toContain(item1)
    expect(fetchedIds).toContain(item3)
    expect(fetchedIds).not.toContain(item2)
  })
})
