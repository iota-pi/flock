import DynamoDriver, { buildDynamoUpdate, getConnectionParams } from './dynamo'
import { InvalidPageTokenError } from './errors'
import type { VaultAccountWithAuth } from './base'
import { generateItemId, type ItemId } from '../../shared/vault/ids'
import { generateAccountId } from '../util'
import { MAX_ITEM_SIZE_BYTES, MAX_ITEM_SIZE_KB } from 'src/shared/vault/limits'

const driver = new DynamoDriver()
describe('DynamoDriver', function () {
  beforeAll(function () {
    driver.connect(getConnectionParams())
  })

  it('set can create and update', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    let cipher = 'hello'
    let iv = 'there'
    const modified = new Date().getTime()

    await driver.set({ account, item, cipher, metadata: { iv, modified } })
    cipher = 'good'
    iv = 'bye'
    await driver.set({ account, item, cipher, metadata: { iv, modified }, version: 1 })
    const results = await driver.fetchByIds({ account, itemIds: [item] })
    expect(results[0]).toEqual({ item, cipher, metadata: { iv, modified }, version: 2 })
  })

  it('set can create and update without version', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const modified = Date.now()

    await driver.set({ account, item, cipher: 'initial', metadata: { iv: 'iv-1', modified } })
    await driver.set({ account, item, cipher: 'second-write', metadata: { iv: 'iv-2', modified: modified + 100 } })
    await driver.set({ account, item, cipher: 'third-write', metadata: { iv: 'iv-3', modified: modified + 200 } })

    const results = await driver.fetchByIds({ account, itemIds: [item] })
    expect(results[0].cipher).toBe('third-write')
  })


  it('set rejects oversized items', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const modified = new Date().getTime()
    const cipher = 'x'.repeat(360_000)

    await expect(
      driver.set({ account, item, cipher, metadata: { iv: 'iv', modified } })
    ).rejects.toThrow('exceeds maximum')
  })

  const authToken = 'an_example_auth_token_for_testing'
  const salt = 'an_example_salt_for_testing'
  const iterations = 100_000
  const session = 'an_example_session_token_for_testing'

  it('createAccount works as expected', async () => {
    const account = generateAccountId()
    const success = await driver.createAccount({
      account,
      authToken,
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
    const params = { account, authToken, salt, iterations }
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
    expect(acc.lastAccess).toBeGreaterThan(Date.now() - 60_000)
  })

  it('raiseDataVersion raises the version but never lowers it', async () => {
    const account = generateAccountId()
    await driver.createAccount({ account, authToken, salt, iterations })
    expect((await driver.getSecurityParams({ account })).dataVersion).toBeUndefined()

    await driver.raiseDataVersion({ account, dataVersion: 2 })
    expect((await driver.getSecurityParams({ account })).dataVersion).toBe(2)

    await driver.raiseDataVersion({ account, dataVersion: 1 })
    expect((await driver.getSecurityParams({ account })).dataVersion).toBe(2)
  })

  it('raiseDataVersion does not create a missing account', async () => {
    const account = generateAccountId()
    await driver.raiseDataVersion({ account, dataVersion: 1 })
    await expect(driver.getSecurityParams({ account })).rejects.toThrow()
  })

  it('listItemFormats describes how each item is stored', async () => {
    const account = generateAccountId()
    const [legacy, unbound, bound, deleted] = [generateItemId(), generateItemId(), generateItemId(), generateItemId()]
    const modified = Date.now()
    const payload = Buffer.from('snapshot').toString('base64')

    await driver.set({ account, item: legacy, cipher: 'legacy-cipher', metadata: { iv: 'iv', modified } })
    await driver.set({ account, item: unbound, metadata: { iv: '', modified }, snapshot: { cipher: payload, iv: 'iv', kver: '1' } })
    await driver.set({ account, item: bound, metadata: { iv: '', modified }, snapshot: { cipher: payload, iv: 'iv', kver: '1', format: 2 } })
    await driver.set({ account, item: deleted, metadata: { iv: '', modified, deleted: true } })

    const formats = await driver.listItemFormats({ account })
    expect(new Map(formats.map(format => [format.itemId, format]))).toEqual(new Map([
      [legacy, { itemId: legacy, deleted: false, hasSnapshot: false, hasCipher: true }],
      [unbound, { itemId: unbound, deleted: false, hasSnapshot: true, hasCipher: false }],
      [bound, { itemId: bound, deleted: false, hasSnapshot: true, snapshotFormat: 2, hasCipher: false }],
      [deleted, { itemId: deleted, deleted: true, hasSnapshot: false, hasCipher: false }],
    ]))
  })

  it('normalizes sessions when updating account data', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
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
    const cipher = 'test-cipher'
    const iv = 'test-iv'
    const modified = 1234567890

    const item1 = generateItemId()
    const item2 = generateItemId()

    await driver.set({ account, item: item1, cipher, metadata: { iv, modified } })
    await driver.set({ account, item: item2, cipher, metadata: { iv, modified: modified + 100 } })

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
    const cipher = 'targeted-cipher'
    const iv = 'targeted-iv'

    const item1 = generateItemId()
    const item2 = generateItemId()
    const item3 = generateItemId()

    await driver.set({ account, item: item1, cipher, metadata: { iv, modified: 100 } })
    await driver.set({ account, item: item2, cipher, metadata: { iv, modified: 200 } })
    await driver.set({ account, item: item3, cipher, metadata: { iv, modified: 300 } })

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
    const payload = Buffer.from('hello-binary-snapshot').toString('base64')
    const modified = Date.now()

    await driver.set({
      account,
      item,
      metadata: { iv: 'iv', modified },
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

  it('keeps the ciphertext format of snapshots and sync messages', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const payload = Buffer.from('doc-bound-snapshot').toString('base64')

    await driver.set({
      account,
      item,
      metadata: { iv: 'iv', modified: Date.now() },
      snapshot: { cipher: payload, iv: 'snapshot-iv', kver: '1', format: 2 },
    })
    await driver.appendSyncMessage({
      account,
      itemId: item,
      entry: {
        cursor: 1,
        encryptedMessage: { iv: 'message-iv', cipher: 'message-cipher', kver: '1', format: 2, version: '1.0' },
        createdAt: Date.now(),
      },
    })

    const [stored] = await driver.fetchByIds({ account, itemIds: [item] })
    expect(stored.snapshot).toEqual({ cipher: payload, iv: 'snapshot-iv', kver: '1', format: 2 })
    const { messages } = await driver.getSyncMessages({ account, itemId: item })
    expect(messages[0].encryptedMessage).toEqual({
      iv: 'message-iv', cipher: 'message-cipher', kver: '1', format: 2, version: '1.0',
    })
  })

  it('payload-less tombstone keeps the previous snapshot and marks the item deleted', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const payload = Buffer.from('last-real-snapshot').toString('base64')
    const modified = Date.now()

    await driver.set({
      account,
      item,
      metadata: { iv: 'iv', modified },
      snapshot: { cipher: payload, iv: 'snapshot-iv', kver: '1' },
    })
    const before = (await driver.fetchByIds({ account, itemIds: [item] }))[0]

    await driver.set({
      account,
      item,
      metadata: { iv: '', modified: modified + 1, deleted: true },
    })

    const after = (await driver.fetchByIds({ account, itemIds: [item] }))[0]
    expect(after.snapshot?.cipher).toBe(payload)
    expect(after.metadata.deleted).toBe(true)
    expect(after.version).toBe((before.version ?? 0) + 1)

    const manifest = await driver.fetchManifest({ account })
    expect(manifest.find(m => m.itemId === item)?.isDeleted).toBe(true)
  })

  it(`rejects snapshots exceeding ${MAX_ITEM_SIZE_KB}KB`, async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const largeBuffer = Buffer.alloc(MAX_ITEM_SIZE_BYTES + 10 * 1024, 0x41)
    const payload = largeBuffer.toString('base64')
    const modified = Date.now()

    await expect(
      driver.set({
        account,
        item,
        metadata: { iv: 'iv', modified },
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

  it('updateAccountData updates app-specific fields and clears them with null', async () => {
    type ExtraFields = { displayName?: string, pausedUntil?: string | null }
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      salt,
      iterations,
    })

    await driver.updateAccountData<ExtraFields>({
      account,
      displayName: 'Test',
      pausedUntil: '2026-10-01T00:00:00Z',
    })

    let stored = await driver.getAccount({ account, session: authToken, isLogin: true }) as VaultAccountWithAuth & ExtraFields
    expect(stored.displayName).toBe('Test')
    expect(stored.pausedUntil).toBe('2026-10-01T00:00:00Z')

    // Now clear the field with null
    await driver.updateAccountData<ExtraFields>({
      account,
      pausedUntil: null,
    })

    stored = await driver.getAccount({ account, session: authToken, isLogin: true }) as VaultAccountWithAuth & ExtraFields
    expect(stored.pausedUntil).toBeNull()
  })

  it('createAccount writes the configured account defaults', async () => {
    const driverWithDefaults = new DynamoDriver({ accountDefaults: { displayName: 'Default' } })
    driverWithDefaults.connect(getConnectionParams())
    const account = generateAccountId()
    await driverWithDefaults.createAccount({
      account,
      authToken,
      salt,
      iterations,
    })

    const stored = await driverWithDefaults.getAccount({ account, session: authToken, isLogin: true })
    expect((stored as VaultAccountWithAuth & { displayName?: string }).displayName).toBe('Default')
  })

  describe('page tokens', () => {
    const encryptedMessage = { iv: 'iv', cipher: 'cipher' }
    const pageToken = (key: Record<string, unknown>) => Buffer.from(JSON.stringify(key)).toString('base64url')

    it('getSyncMessages pages through an item with opaque tokens', async () => {
      const account = generateAccountId()
      const itemId = generateItemId()
      await driver.pushSyncMessagesBatch({
        account,
        messages: [110, 120, 130, 140, 150].map(cursor => ({
          itemId, entry: { cursor, encryptedMessage, createdAt: 1 }, lastModified: 1,
        })),
      })

      const cursors: number[] = []
      let token: string | undefined
      let pages = 0
      do {
        const page = await driver.getSyncMessages({ account, itemId, fromCursor: 100, limit: 2, pageToken: token })
        cursors.push(...page.messages.map(m => m.cursor))
        token = page.nextPageToken
        expect(page.hasMore).toBe(!!token)
        pages += 1
      } while (token && pages < 10)

      expect(cursors).toEqual([110, 120, 130, 140, 150])
    })

    it('getSyncMessages rejects a token for another item', async () => {
      const account = generateAccountId()
      const itemId = generateItemId() as ItemId

      await expect(
        driver.getSyncMessages({ account, itemId, pageToken: pageToken({ syncId: 'wrong-account#item-1', cursor: 100 }) })
      ).rejects.toThrow(InvalidPageTokenError)
    })

    it('getSyncMessages rejects a token that starts before fromCursor', async () => {
      const account = generateAccountId()
      const itemId = generateItemId() as ItemId

      await expect(
        driver.getSyncMessages({ account, itemId, fromCursor: 500, pageToken: pageToken({ syncId: `${account}#${itemId}`, cursor: 499 }) })
      ).rejects.toThrow('Page token cannot start before cursor 500')
    })

    it('getSyncMessages rejects malformed tokens', async () => {
      const account = generateAccountId()
      const itemId = generateItemId() as ItemId

      for (const token of ['not-a-token', pageToken({ syncId: `${account}#${itemId}`, cursor: -5 })]) {
        await expect(driver.getSyncMessages({ account, itemId, pageToken: token })).rejects.toThrow('Page token is malformed')
      }
    })

    it('getGlobalSyncMessagesAfterCursor reports the highest cursor scanned', async () => {
      const account = generateAccountId()
      const itemA = generateItemId()
      const itemB = generateItemId()
      await driver.pushSyncMessagesBatch({
        account,
        messages: [
          { itemId: itemA, entry: { cursor: 110, encryptedMessage, createdAt: 1 }, lastModified: 1 },
          { itemId: itemB, entry: { cursor: 120, encryptedMessage, createdAt: 1 }, lastModified: 1 },
          { itemId: itemA, entry: { cursor: 130, encryptedMessage, createdAt: 1 }, lastModified: 1 },
        ],
      })

      const page = await driver.getGlobalSyncMessagesAfterCursor({ account, cursor: 100 })
      expect(page.scannedThroughCursor).toBe(130)
      expect(page.hasMore).toBe(false)
      expect(page.nextPageToken).toBeUndefined()

      const empty = await driver.getGlobalSyncMessagesAfterCursor({ account, cursor: 500 })
      expect(empty.items).toEqual([])
      expect(empty.scannedThroughCursor).toBe(500)

      const continuation = await driver.getGlobalSyncMessagesAfterCursor({
        account,
        cursor: 100,
        pageToken: pageToken({ account, cursor: 120, syncId: `${account}#${itemB}` }),
      })
      expect(continuation.items.flatMap(i => i.messages.map(m => m.cursor))).toEqual([130])
      expect(continuation.scannedThroughCursor).toBe(130)
    })

    it('getGlobalSyncMessagesAfterCursor rejects a token for another account', async () => {
      const account = generateAccountId()

      for (const key of [
        { account: 'other-account', cursor: 100, syncId: 'other-account#item-1' },
        { account, cursor: 100, syncId: 'wrong-account#item-1' },
      ]) {
        await expect(
          driver.getGlobalSyncMessagesAfterCursor({ account, pageToken: pageToken(key) })
        ).rejects.toThrow(`Page token is for another account: expected ${account}`)
      }
    })

    it('validatePageToken applies the same checks without querying', () => {
      const account = 'acct'
      const itemId = 'item-1' as ItemId

      expect(() => driver.validatePageToken({ account, itemId, cursor: 10, pageToken: pageToken({ syncId: 'acct#item-1', cursor: 10 }) })).not.toThrow()
      expect(() => driver.validatePageToken({ account, itemId, cursor: 11, pageToken: pageToken({ syncId: 'acct#item-1', cursor: 10 }) })).toThrow(InvalidPageTokenError)
      expect(() => driver.validatePageToken({ account, pageToken: pageToken({ account, cursor: 1, syncId: 'acct#item-9' }) })).not.toThrow()
      expect(() => driver.validatePageToken({ account, pageToken: pageToken({ syncId: 'acct#item-1', cursor: 10 }) })).toThrow(InvalidPageTokenError)
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

