import DynamoDriver, { buildDynamoUpdate, getConnectionParams } from './dynamo'
import { generateItemId } from '../../utils'
import { generateAccountId } from '../util'
import type { ItemType } from 'src/shared/itemTypes'
import { ItemId } from 'src/shared/schemas/items'

const driver = new DynamoDriver()
describe('DynamoDriver', function () {
  beforeAll(function () {
    driver.connect(getConnectionParams())
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
    await driver.set({ account, item, cipher, metadata: { type, iv, modified }, version: 1 })
    const results = await driver.fetchByIds({ account, itemIds: [item] })
    expect(results[0]).toEqual({ item, cipher, metadata: { type, iv, modified }, version: 2 })
  })

  it('set can create and update without version', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
    const modified = Date.now()

    await driver.set({ account, item, cipher: 'initial', metadata: { type, iv: 'iv-1', modified } })
    await driver.set({ account, item, cipher: 'second-write', metadata: { type, iv: 'iv-2', modified: modified + 100 } })
    await driver.set({ account, item, cipher: 'third-write', metadata: { type, iv: 'iv-3', modified: modified + 200 } })

    const results = await driver.fetchByIds({ account, itemIds: [item] })
    expect(results[0].cipher).toBe('third-write')
  })


  it('set rejects oversized items', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
    const modified = new Date().getTime()
    const cipher = 'x'.repeat(360_000)

    await expect(
      driver.set({ account, item, cipher, metadata: { type, iv: 'iv', modified } })
    ).rejects.toThrow('exceeds maximum')
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
      (await driver.getAccount({ account, session: authToken, isLogin: true })).account
    ).toBe(account)
    await expect(
      driver.getAccount({ account, session: authToken, isLogin: false })
    ).rejects.toThrow()
    await expect(
      driver.getAccount({ account, session: authToken })
    ).rejects.toThrow()
  })

  it('getAccount session validation works based on session', async () => {
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
    await expect(
      driver.getAccount({ account, session })
    ).rejects.toThrow()
    await expect(
      driver.getAccount({ account, session: authToken })
    ).rejects.toThrow()
    expect(
      (await driver.getAccount({ account, session: newSession })).account
    ).toBe(account)
    await expect(
      driver.getAccount({ account, session: 'wrong' })
    ).rejects.toThrow()
    await expect(
      driver.getAccount({ account, session: '' })
    ).rejects.toThrow()
  })

  it('getAccount accepts multiple active sessions', async () => {
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

    expect((await driver.getAccount({ account, session: sessionA })).account).toBe(account)
    expect((await driver.getAccount({ account, session: sessionB })).account).toBe(account)
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
      (await driver.getAccount({ account, session: sessionA })).account
    ).toBe(account)

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
    expect((await driver.getAccount({ account, session: sessionA })).account).toBe(account)
    expect((await driver.getAccount({ account, session: sessionB })).account).toBe(account)

    // Simulate changePassword by updating sessions array to only contain sessionA
    await driver.updateAccountData({
      account,
      sessions: [{ token: sessionA, expiry }],
    })

    // Now sessionA is valid, sessionB is revoked
    expect((await driver.getAccount({ account, session: sessionA })).account).toBe(account)
    await expect(driver.getAccount({ account, session: sessionB })).rejects.toThrow()
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

  it('stores small snapshot inline as binary and returns as base64', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
    const payload = Buffer.from('hello-binary-snapshot').toString('base64')
    const modified = Date.now()

    await driver.set({
      account,
      item,
      metadata: { type, iv: 'iv', modified },
      snapshot: {
        cipher: payload,
        iv: 'snapshot-iv',
        kver: '1',
      },
    })

    const results = await driver.fetchByIds({ account, itemIds: [item] })
    expect(results.length).toBe(1)
    expect(results[0].snapshot?.cipher).toBe(payload)
    expect(results[0].snapshot?.iv).toBe('snapshot-iv')
  })

  it('rejects snapshots exceeding 350KB', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
    const largeBuffer = Buffer.alloc(360 * 1024, 0x41)
    const payload = largeBuffer.toString('base64')
    const modified = Date.now()

    await expect(
      driver.set({
        account,
        item,
        metadata: { type, iv: 'iv', modified },
        snapshot: {
          cipher: payload,
          iv: 'snapshot-iv',
          kver: '1',
        },
      }),
    ).rejects.toThrow('exceeds maximum')
  })

  it('updateAccountData returns early without throwing when no update fields are provided', async () => {
    const account = generateAccountId()
    await expect(driver.updateAccountData({ account })).resolves.toBeUndefined()
  })

  it('updateAccountData updates arbitrary fields including reminder settings and clears snooze with null', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata: {},
      salt,
      iterations,
    })

    await driver.updateAccountData({
      account,
      reminderEnabled: true,
      reminderTime: '09:30',
      reminderTimezone: 'America/New_York',
      snoozeRemindersUntil: '2026-10-01T00:00:00Z',
    })

    let stored = await driver.getAccount({ account, session: authToken, isLogin: true })
    expect(stored.reminderEnabled).toBe(true)
    expect(stored.reminderTime).toBe('09:30')
    expect(stored.reminderTimezone).toBe('America/New_York')
    expect(stored.snoozeRemindersUntil).toBe('2026-10-01T00:00:00Z')

    // Now clear snooze with null
    await driver.updateAccountData({
      account,
      snoozeRemindersUntil: null,
    })

    stored = await driver.getAccount({ account, session: authToken, isLogin: true })
    expect(stored.snoozeRemindersUntil).toBeNull()
  })

  describe('exclusiveStartKey validation', () => {
    it('getSyncMessages rejects exclusiveStartKey with mismatched syncId', async () => {
      const account = generateAccountId()
      const itemId = generateItemId() as ItemId

      await expect(
        driver.getSyncMessages({
          account,
          itemId,
          exclusiveStartKey: { syncId: 'wrong-account#item-1', cursor: 100 },
        })
      ).rejects.toThrow(`Invalid exclusiveStartKey syncId: expected ${account}#${itemId}`)
    })

    it('getSyncMessages rejects exclusiveStartKey with invalid cursor', async () => {
      const account = generateAccountId()
      const itemId = generateItemId() as ItemId

      await expect(
        driver.getSyncMessages({
          account,
          itemId,
          exclusiveStartKey: { syncId: `${account}#${itemId}`, cursor: -5 },
        })
      ).rejects.toThrow('Invalid exclusiveStartKey cursor: must be a non-negative number')
    })

    it('getGlobalSyncMessagesAfterCursor rejects exclusiveStartKey with mismatched account', async () => {
      const account = generateAccountId()

      await expect(
        driver.getGlobalSyncMessagesAfterCursor({
          account,
          exclusiveStartKey: { account: 'other-account', cursor: 100, syncId: 'other-account#item-1' },
        })
      ).rejects.toThrow(`Invalid exclusiveStartKey account: expected ${account}`)
    })

    it('getGlobalSyncMessagesAfterCursor rejects exclusiveStartKey with mismatched syncId prefix', async () => {
      const account = generateAccountId()

      await expect(
        driver.getGlobalSyncMessagesAfterCursor({
          account,
          exclusiveStartKey: { account, cursor: 100, syncId: 'wrong-account#item-1' },
        })
      ).rejects.toThrow(`Invalid exclusiveStartKey syncId: expected prefix ${account}#`)
    })
  })
})

describe('buildDynamoUpdate', () => {
  it('builds SET expression and mapped values for provided fields', () => {
    const result = buildDynamoUpdate({
      reminderEnabled: true,
      reminderTime: '08:00',
      iterations: 5000,
    })

    expect(result.expression).toBe('SET reminderEnabled = :reminderEnabled, reminderTime = :reminderTime, iterations = :iterations')
    expect(result.values).toEqual({
      ':reminderEnabled': true,
      ':reminderTime': '08:00',
      ':iterations': 5000,
    })
  })

  it('filters out undefined values while preserving null, false, 0, and empty string', () => {
    const result = buildDynamoUpdate({
      definedString: 'flock',
      emptyString: '',
      nullValue: null,
      falseValue: false,
      zeroValue: 0,
      undefinedValue: undefined,
    })

    expect(result.expression).toBe('SET definedString = :definedString, emptyString = :emptyString, nullValue = :nullValue, falseValue = :falseValue, zeroValue = :zeroValue')
    expect(result.values).toEqual({
      ':definedString': 'flock',
      ':emptyString': '',
      ':nullValue': null,
      ':falseValue': false,
      ':zeroValue': 0,
    })
  })

  it('returns empty expression and empty values when given an empty object or all-undefined fields', () => {
    expect(buildDynamoUpdate({})).toEqual({
      expression: '',
      values: {},
    })

    expect(buildDynamoUpdate({ a: undefined, b: undefined })).toEqual({
      expression: '',
      values: {},
    })
  })
})

