import { PutCommand } from '@aws-sdk/lib-dynamodb'
import DynamoDriver, { SYNC_MESSAGE_PAGE_SIZE } from './driver'
import { authenticateLogin, authenticateSession } from '../../authentication'
import { AuthenticationError, InvalidPageTokenError } from '../../errors'
import type { VaultAccountWithAuth } from '../vaultDriver'
import { generateItemId, type ItemId } from '@vault/shared'
import { generateAccountId } from '../../util'
import { MAX_ITEM_SIZE_BYTES, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { isSessionFor, SESSION_EXPIRY_MS } from '../../sessions'

const generateTestAccountId = () => generateAccountId(10)

const driver = new DynamoDriver()

async function login(account: string, authTokenHash: string) {
  const record = await driver.getAccountRecord({ account })
  authenticateLogin(record, authTokenHash)
  if (!record) {
    throw new Error(`Could not find account ${account}`)
  }
  return record
}

async function getWithSession(account: string, session: string) {
  return authenticateSession(await driver.getAccountRecord({ account }), session)
}
describe('DynamoDriver', function () {
  beforeAll(function () {
    driver.connect()
  })

  it('set can create and update, bumping the version on each write', async () => {
    const account = generateTestAccountId()
    const item = generateItemId()
    const modified = Date.now()

    await expect(driver.set({ account, item, cipher: 'hello', metadata: { iv: 'there', modified } }))
      .resolves.toEqual({ version: 1 })
    await expect(driver.set({ account, item, cipher: 'good', metadata: { iv: 'bye', modified } }))
      .resolves.toEqual({ version: 2 })
    const results = await driver.fetchByIds({ account, itemIds: [item] })
    expect(results[0]).toEqual({ item, cipher: 'good', metadata: { iv: 'bye', modified }, version: 2 })
  })

  it('removes the legacy cipher when a snapshot is written', async () => {
    const account = generateTestAccountId()
    const item = generateItemId()
    const modified = Date.now()

    await driver.set({ account, item, cipher: 'legacy', metadata: { iv: 'iv-1', modified } })
    await driver.set({
      account,
      item,
      metadata: { iv: '', modified: modified + 100 },
      snapshot: { iv: 'snap-iv', cipher: 'c25hcHNob3Q=', kver: '1', format: 2 },
    })

    const [result] = await driver.fetchByIds({ account, itemIds: [item] })
    expect(result.cipher).toBeUndefined()
    expect(result.snapshot).toMatchObject({ iv: 'snap-iv', format: 2 })
  })

  it('keeps the legacy cipher for a tombstone without a snapshot', async () => {
    const account = generateTestAccountId()
    const item = generateItemId()
    const modified = Date.now()

    await driver.set({ account, item, cipher: 'legacy', metadata: { iv: 'iv-1', modified } })
    await driver.set({ account, item, metadata: { iv: '', modified: modified + 100, deleted: true } })

    const [result] = await driver.fetchByIds({ account, itemIds: [item] })
    expect(result.cipher).toBe('legacy')
    expect(result.metadata.deleted).toBe(true)
  })


  it('keeps an item deleted when a snapshot without the deletion is written after it', async () => {
    const account = generateTestAccountId()
    const item = generateItemId()
    const modified = Date.now()
    const snapshot = { iv: 'snap-iv', cipher: 'c25hcHNob3Q=', kver: '1', format: 2 as const }

    await driver.set({ account, item, metadata: { iv: '', modified }, snapshot })
    await driver.set({ account, item, metadata: { iv: '', modified: modified + 100, deleted: true } })
    // From a device that hasn't seen the delete yet
    await expect(driver.set({ account, item, metadata: { iv: '', modified: modified + 200 }, snapshot }))
      .resolves.toEqual({ version: 3 })

    const [result] = await driver.fetchByIds({ account, itemIds: [item] })
    expect(result.metadata).toEqual({ iv: '', modified: modified + 200, deleted: true })
    expect(result.snapshot).toMatchObject({ iv: 'snap-iv' })
    const manifest = await driver.fetchManifest({ account })
    expect(manifest).toEqual([expect.objectContaining({ itemId: item, isDeleted: true, version: 3 })])
  })

  it('keeps an item deleted by the legacy top-level attribute', async () => {
    const account = generateTestAccountId()
    const item = generateItemId()
    const modified = Date.now()

    await driver.client.send(new PutCommand({
      TableName: driver.tables.items,
      Item: { account, item, cipher: 'legacy', metadata: { iv: 'iv-1', modified }, deleted: true, version: 1 },
    }))
    await driver.set({ account, item, metadata: { iv: '', modified: modified + 100 }, snapshot: { iv: 'snap-iv', cipher: 'c25hcHNob3Q=' } })

    const [result] = await driver.fetchByIds({ account, itemIds: [item] })
    expect(result.metadata.deleted).toBe(true)
  })

  it('set rejects oversized items', async () => {
    const account = generateTestAccountId()
    const item = generateItemId()
    const modified = new Date().getTime()
    const cipher = 'x'.repeat(360_000)

    await expect(
      driver.set({ account, item, cipher, metadata: { iv: 'iv', modified } })
    ).rejects.toThrow('exceeds maximum')
  })

  it('measures a snapshot as stored, in binary, not as its longer base64 text', async () => {
    const account = generateTestAccountId()
    const item = generateItemId()
    // About 400 KB of base64, more than the client's limit on base64 text allows, but 300 KB stored
    const cipher = Buffer.alloc(300_000, 7).toString('base64')
    expect(cipher.length).toBeGreaterThan(MAX_ITEM_SIZE_BYTES)

    await driver.set({ account, item, metadata: { iv: '', modified: Date.now() }, snapshot: { iv: 'snap-iv', cipher } })
    const [stored] = await driver.fetchByIds({ account, itemIds: [item] })
    expect(stored.snapshot?.cipher).toBe(cipher)
  })

  const authToken = 'an_example_auth_token_for_testing'
  const salt = 'an_example_salt_for_testing'
  const iterations = 100_000
  const session = 'an_example_session_token_for_testing'

  it('createAccount works as expected', async () => {
    const account = generateTestAccountId()
    const success = await driver.createAccount({
      account,
      authToken,
      salt,
      iterations,
    })
    expect(success).toBe(true)
  })

  it('login works based on authToken', async () => {
    const account = generateTestAccountId()
    await driver.createAccount({
      account,
      authToken,
      salt,
      iterations,
    })

    expect(
      (await login(account, authToken)).account
    ).toBe(account)
    await expect(
      getWithSession(account, authToken)
    ).rejects.toThrow()
    await expect(
      getWithSession(account, authToken)
    ).rejects.toThrow()
  })

  it('sessions authenticate against the stored record', async () => {
    const account = generateTestAccountId()
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
      getWithSession(account, session)
    ).rejects.toThrow()
    await expect(
      getWithSession(account, authToken)
    ).rejects.toThrow()
    expect(
      (await getWithSession(account, newSession)).account
    ).toBe(account)
    await expect(
      getWithSession(account, 'wrong')
    ).rejects.toThrow()
    await expect(
      getWithSession(account, '')
    ).rejects.toThrow()
  })

  it('accepts multiple active sessions', async () => {
    const account = generateTestAccountId()
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

    expect((await getWithSession(account, sessionA)).account).toBe(account)
    expect((await getWithSession(account, sessionB)).account).toBe(account)
  })

  it('repeated createAccount calls fail', async () => {
    const account = generateTestAccountId()
    const params = { account, authToken, salt, iterations }
    const result1 = await driver.createAccount(params)
    expect(result1).toBe(true)
    const result2 = await driver.createAccount(params)
    expect(result2).toBe(false)
    const result3 = await driver.createAccount(params)
    expect(result3).toBe(false)
  })

  it('extendSession updates sessionExpiry', async () => {
    const account = generateTestAccountId()
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
      (await getWithSession(account, sessionA)).account
    ).toBe(account)

    // Extend the session
    await driver.extendSession({ account, session: sessionA })

    // Check the updated expiry in the stored record
    const acc = await getWithSession(account, sessionA)
    const updatedSession = acc.sessions?.find(s => isSessionFor(s, sessionA))
    expect(updatedSession?.expiry).toBeGreaterThan(Date.now() + 10000)
    expect(acc.lastAccess).toBeGreaterThan(Date.now() - 60_000)
  })

  it('raiseDataVersion raises the version but never lowers it', async () => {
    const account = generateTestAccountId()
    await driver.createAccount({ account, authToken, salt, iterations })
    expect((await driver.getAccountRecord({ account }))?.dataVersion).toBeUndefined()

    await driver.raiseDataVersion({ account, dataVersion: 2 })
    expect((await driver.getAccountRecord({ account }))?.dataVersion).toBe(2)

    await driver.raiseDataVersion({ account, dataVersion: 1 })
    expect((await driver.getAccountRecord({ account }))?.dataVersion).toBe(2)
  })

  it('raiseDataVersion does not create a missing account', async () => {
    const account = generateTestAccountId()
    await driver.raiseDataVersion({ account, dataVersion: 1 })
    await expect(driver.getAccountRecord({ account })).resolves.toBeUndefined()
  })

  it('listItemFormats describes how each item is stored', async () => {
    const account = generateTestAccountId()
    const [legacy, unbound, bound, rotated, deleted] = [
      generateItemId(), generateItemId(), generateItemId(), generateItemId(), generateItemId(),
    ]
    const modified = Date.now()
    const payload = Buffer.from('snapshot').toString('base64')

    await driver.set({ account, item: legacy, cipher: 'legacy-cipher', metadata: { iv: 'iv', modified } })
    await driver.set({ account, item: unbound, metadata: { iv: '', modified }, snapshot: { cipher: payload, iv: 'iv', kver: '1' } })
    await driver.set({ account, item: bound, metadata: { iv: '', modified }, snapshot: { cipher: payload, iv: 'iv', kver: '1', format: 2 } })
    await driver.set({ account, item: rotated, metadata: { iv: '', modified }, snapshot: { cipher: payload, iv: 'iv', kver: '2', format: 2 } })
    await driver.set({ account, item: deleted, metadata: { iv: '', modified, deleted: true } })

    const formats = await driver.listItemFormats({ account })
    expect(new Map(formats.map(format => [format.itemId, format]))).toEqual(new Map([
      [legacy, { itemId: legacy, deleted: false, hasSnapshot: false, hasCipher: true }],
      [unbound, { itemId: unbound, deleted: false, hasSnapshot: true, snapshotKver: '1', hasCipher: false }],
      [bound, { itemId: bound, deleted: false, hasSnapshot: true, snapshotFormat: 2, snapshotKver: '1', hasCipher: false }],
      [rotated, { itemId: rotated, deleted: false, hasSnapshot: true, snapshotFormat: 2, snapshotKver: '2', hasCipher: false }],
      [deleted, { itemId: deleted, deleted: true, hasSnapshot: false, hasCipher: false }],
    ]))
  })

  it('stores and returns the Argon2id parameters of an account', async () => {
    const account = generateTestAccountId()
    const kdf = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }
    await driver.createAccount({
      account,
      authToken,
      salt,
      saltVersion: 1,
      kdf,
      keyring: 'encrypted-keyring',
      randomDataKeys: true,
    })

    const stored = await login(account, authToken)
    expect(stored).toMatchObject({ salt, saltVersion: 1, kdf, keyring: 'encrypted-keyring', randomDataKeys: true, keyringVersion: 1 })
    expect(stored).not.toHaveProperty('dataVersion')
    expect(stored).not.toHaveProperty('iterations')
  })

  it('normalizes sessions when updating account data', async () => {
    const account = generateTestAccountId()
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

    const result = await getWithSession(account, 'session-9')
    const tokens = result.sessions?.map(entry => entry.token) ?? []

    expect(tokens.length).toBe(8)
    expect(tokens).toContain('session-9')
    expect(tokens).not.toContain('session-1')
  })

  it('drops sessions that expire later than the current session lifetime allows', async () => {
    const account = generateTestAccountId()
    await driver.createAccount({
      account,
      authToken,
      salt,
      iterations,
    })

    const now = Date.now()
    await driver.updateAccountData({
      account,
      sessions: [
        { token: 'old-lifetime', expiry: now + 30 * 24 * 60 * 60 * 1000 },
        { token: 'current-lifetime', expiry: now + SESSION_EXPIRY_MS },
      ],
    })

    await expect(getWithSession(account, 'old-lifetime')).rejects.toThrow(AuthenticationError)
    const result = await getWithSession(account, 'current-lifetime')
    expect(result.sessions?.map(entry => entry.token)).toEqual(['current-lifetime'])
  })

  it('can save and retrieve keyring', async () => {
    const account = generateTestAccountId()
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

    const result = await getWithSession(account, testSession)
    expect(result.keyring).toBe(keyringValue)
  })

  it('can push and get sync messages, in cursor order', async () => {
    const account = generateTestAccountId()
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

    // Pushed out of order, to check the query returns them in cursor order
    await driver.pushSyncMessagesBatch({ account, messages: [{ itemId, entry: entry2 }] })
    await driver.pushSyncMessagesBatch({ account, messages: [{ itemId, entry: entry1 }] })

    const result = await driver.getSyncMessages({ account, itemId })
    expect(result.messages.length).toBe(2)
    expect(result.messages.map(m => m.cursor)).toEqual([1001, 1002])
  })

  it('session eviction on updateAccountData works', async () => {
    const account = generateTestAccountId()
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
    expect((await getWithSession(account, sessionA)).account).toBe(account)
    expect((await getWithSession(account, sessionB)).account).toBe(account)

    // Simulate changePassword by updating sessions array to only contain sessionA
    await driver.updateAccountData({
      account,
      sessions: [{ token: sessionA, expiry }],
    })

    // Now sessionA is valid, sessionB is revoked
    expect((await getWithSession(account, sessionA)).account).toBe(account)
    await expect(getWithSession(account, sessionB)).rejects.toThrow()
  })

  it('fetchManifest returns item and modifiedAt tuples without payload', async () => {
    const account = generateTestAccountId()
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
    const account = generateTestAccountId()
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
    const account = generateTestAccountId()
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
    const account = generateTestAccountId()
    const item = generateItemId()
    const payload = Buffer.from('doc-bound-snapshot').toString('base64')

    await driver.set({
      account,
      item,
      metadata: { iv: 'iv', modified: Date.now() },
      snapshot: { cipher: payload, iv: 'snapshot-iv', kver: '1', format: 2 },
    })
    await driver.pushSyncMessagesBatch({
      account,
      messages: [{
        itemId: item,
        entry: {
          cursor: 1,
          encryptedMessage: { iv: 'message-iv', cipher: 'message-cipher', kver: '1', format: 2, version: '1.0' },
          createdAt: Date.now(),
        },
      }],
    })

    const [stored] = await driver.fetchByIds({ account, itemIds: [item] })
    expect(stored.snapshot).toEqual({ cipher: payload, iv: 'snapshot-iv', kver: '1', format: 2 })
    const { messages } = await driver.getSyncMessages({ account, itemId: item })
    expect(messages[0].encryptedMessage).toEqual({
      iv: 'message-iv', cipher: 'message-cipher', kver: '1', format: 2, version: '1.0',
    })
  })

  it('payload-less tombstone keeps the previous snapshot and marks the item deleted', async () => {
    const account = generateTestAccountId()
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
    const account = generateTestAccountId()
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
    const account = generateTestAccountId()
    await expect(driver.updateAccountData({ account })).resolves.toBeUndefined()
  })

  it('updateAccountData updates app-specific fields and clears them with null', async () => {
    type ExtraFields = { displayName?: string, pausedUntil?: string | null }
    const account = generateTestAccountId()
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

    let stored = await login(account, authToken) as VaultAccountWithAuth & ExtraFields
    expect(stored.displayName).toBe('Test')
    expect(stored.pausedUntil).toBe('2026-10-01T00:00:00Z')

    // Now clear the field with null
    await driver.updateAccountData<ExtraFields>({
      account,
      pausedUntil: null,
    })

    stored = await login(account, authToken) as VaultAccountWithAuth & ExtraFields
    expect(stored.pausedUntil).toBeNull()
  })

  it('createAccount writes the configured account defaults', async () => {
    const driverWithDefaults = new DynamoDriver({ accountDefaults: { displayName: 'Default' } })
    driverWithDefaults.connect()
    const account = generateTestAccountId()
    await driverWithDefaults.createAccount({
      account,
      authToken,
      salt,
      iterations,
    })

    const stored = await driverWithDefaults.getAccountRecord({ account })
    authenticateLogin(stored, authToken)
    expect((stored as VaultAccountWithAuth & { displayName?: string }).displayName).toBe('Default')
  })

  describe('page tokens', () => {
    const encryptedMessage = { iv: 'iv', cipher: 'cipher' }
    const pageToken = (key: Record<string, unknown>) => Buffer.from(JSON.stringify(key)).toString('base64url')

    it('getSyncMessages pages through an item with opaque tokens', async () => {
      const account = generateTestAccountId()
      const itemId = generateItemId()
      // More messages than fit on one page
      const pushed = Array.from({ length: SYNC_MESSAGE_PAGE_SIZE + 1 }, (_, i) => 101 + i)
      await driver.pushSyncMessagesBatch({
        account,
        messages: [100, ...pushed].map(cursor => ({
          itemId, entry: { cursor, encryptedMessage, createdAt: 1 },
        })),
      })

      const cursors: number[] = []
      let token: string | undefined
      let pages = 0
      do {
        const page = await driver.getSyncMessages({ account, itemId, fromCursor: 100, pageToken: token })
        cursors.push(...page.messages.map(m => m.cursor))
        token = page.nextPageToken
        expect(page.hasMore).toBe(!!token)
        pages += 1
      } while (token && pages < 10)

      expect(pages).toBeGreaterThan(1)
      expect(cursors).toEqual(pushed)
    })

    it('getSyncMessages rejects a token for another item', async () => {
      const account = generateTestAccountId()
      const itemId = generateItemId() as ItemId

      await expect(
        driver.getSyncMessages({ account, itemId, pageToken: pageToken({ syncId: 'wrong-account#item-1', cursor: 100 }) })
      ).rejects.toThrow(InvalidPageTokenError)
    })

    it('getSyncMessages rejects a token that starts before fromCursor', async () => {
      const account = generateTestAccountId()
      const itemId = generateItemId() as ItemId

      await expect(
        driver.getSyncMessages({ account, itemId, fromCursor: 500, pageToken: pageToken({ syncId: `${account}#${itemId}`, cursor: 499 }) })
      ).rejects.toThrow('Page token cannot start before cursor 500')
    })

    it('getSyncMessages rejects malformed tokens', async () => {
      const account = generateTestAccountId()
      const itemId = generateItemId() as ItemId

      for (const token of ['not-a-token', pageToken({ syncId: `${account}#${itemId}`, cursor: -5 })]) {
        await expect(driver.getSyncMessages({ account, itemId, pageToken: token })).rejects.toThrow('Page token is malformed')
      }
    })

    it('getGlobalSyncMessagesAfterCursor reports the highest cursor scanned', async () => {
      const account = generateTestAccountId()
      const itemA = generateItemId()
      const itemB = generateItemId()
      await driver.pushSyncMessagesBatch({
        account,
        messages: [
          { itemId: itemA, entry: { cursor: 110, encryptedMessage, createdAt: 1 } },
          { itemId: itemB, entry: { cursor: 120, encryptedMessage, createdAt: 1 } },
          { itemId: itemA, entry: { cursor: 130, encryptedMessage, createdAt: 1 } },
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

    it('getGlobalSyncMessagesAfterCursor keeps an item ID that contains #', async () => {
      const account = generateTestAccountId()
      const itemId = 'item#with#hashes' as ItemId
      await driver.pushSyncMessagesBatch({
        account,
        messages: [{ itemId, entry: { cursor: 110, encryptedMessage, createdAt: 1 } }],
      })

      const page = await driver.getGlobalSyncMessagesAfterCursor({ account, cursor: 100 })
      expect(page.items.map(i => i.itemId)).toEqual([itemId])
      const itemPage = await driver.getSyncMessages({ account, itemId })
      expect(itemPage.messages.map(m => m.cursor)).toEqual([110])
    })

    it('getGlobalSyncMessagesAfterCursor rejects a token for another account', async () => {
      const account = generateTestAccountId()

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
