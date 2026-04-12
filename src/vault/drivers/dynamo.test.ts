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

  it('set enforces branch parent lineage when expected parent is provided', async () => {
    const account = generateAccountId()
    const item = generateItemId()
    const type: ItemType = 'person'
    const iv = 'there'
    const modified = new Date().getTime()
    const baseBranch = {
      encryptedAutomergeDoc: 'branch-base',
      versionId: 'v1',
      parentIds: [],
    }

    await driver.set({
      account,
      item,
      branches: [baseBranch],
      metadata: { type, iv, modified },
    } as unknown as Parameters<typeof driver.set>[0])

    // Wrong expected parent should fail.
    await expect(
      driver.set({
        account,
        item,
        branches: [{
          encryptedAutomergeDoc: 'branch-next',
          versionId: 'v2',
          parentIds: ['wrong-parent'],
        }],
        metadata: { type, iv, modified },
        _expectedParentVersionId: 'wrong-parent',
      } as unknown as Parameters<typeof driver.set>[0])
    ).rejects.toThrow('Version conflict')

    // Correct expected parent should succeed.
    await driver.set({
      account,
      item,
      branches: [{
        encryptedAutomergeDoc: 'branch-next',
        versionId: 'v2',
        parentIds: ['v1'],
      }],
      metadata: { type, iv, modified },
      _expectedParentVersionId: 'v1',
    } as unknown as Parameters<typeof driver.set>[0])

    const result = await driver.get({ account, item })
    expect(result.branches?.[0]?.versionId).toBe('v2')
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

    const [result] = await driver.fetchMany({ account, ids: [item] })
    expect(result.metadata.deleted).toBe(true)
    expect(typeof result.ttl).toBe('number')
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

  it('fetchAll with cacheTime returns only modified delta items', async () => {
    const account = generateAccountId()
    const oldItem = generateItemId()
    const newItem = generateItemId()
    const type: ItemType = 'person'
    const iv = 'iv'
    const cipher = 'cipher'

    const oldModified = Date.now() - 10_000
    const newModified = Date.now()

    await driver.set({
      account,
      item: oldItem,
      cipher,
      metadata: { type, iv, modified: oldModified },
    })
    await driver.set({
      account,
      item: newItem,
      cipher,
      metadata: { type, iv, modified: newModified },
    })

    const result = await driver.fetchAll({ account, cacheTime: oldModified + 1 })

    expect(result.find(i => i.item === newItem)).toBeTruthy()
    expect(result.find(i => i.item === oldItem)).toBeFalsy()
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

  it('extendSession updates sessionExpiry', async () => {
    const account = generateAccountId()
    await driver.createAccount({
      account,
      authToken,
      metadata,
      salt,
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
})
