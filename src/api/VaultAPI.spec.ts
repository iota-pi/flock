import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from './VaultAPI'
import * as util from './util'

const trpcMock = vi.hoisted(() => ({
  items: {
    fetchMany: { query: vi.fn() },
    put: { mutate: vi.fn() },
    putMany: { mutate: vi.fn() },
    delete: { mutate: vi.fn() },
    deleteMany: { mutate: vi.fn() },
  },
  accounts: {
    createAccount: { mutate: vi.fn() },
    getSalt: { query: vi.fn() },
    login: { mutate: vi.fn() },
    getMetadata: { query: vi.fn() },
    updateMetadata: { mutate: vi.fn() },
    addPushSubscription: { mutate: vi.fn() },
    deletePushSubscription: { mutate: vi.fn() },
    getReminderSettings: { query: vi.fn() },
    updateReminderSettings: { mutate: vi.fn() },
    recordPrayerCompletion: { mutate: vi.fn() },
  },
}))

vi.mock('./trpcClient', () => {
  return {
    trpcClient: trpcMock,
  }
})

function ok<T>(data: T) {
  return {
    data,
    response: new Response(null, { status: 200 }),
  }
}

describe('VaultAPI', () => {
  const putManyItems = [
    { item: 'a', cipher: 'cipher-a', metadata: { iv: 'iv-a', type: 'person', modified: 1 } },
    { item: 'b', cipher: 'cipher-b', metadata: { iv: 'iv-b', type: 'person', modified: 2 } },
  ] as any

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(util, 'getAccountId').mockReturnValue('acct1')
    Object.values(trpcMock.items).forEach(method => Object.values(method).forEach(mockFn => mockFn.mockReset()))
    Object.values(trpcMock.accounts).forEach(method => Object.values(method).forEach(mockFn => mockFn.mockReset()))
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('vaultFetchMany with cacheTime returns items', async () => {
    const expected = [{ item: 'a', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } }]
    trpcMock.items.fetchMany.query.mockResolvedValue(ok({ success: true, items: expected }).data)

    const result = await api.vaultFetchMany({ cacheTime: 123 })
    expect(result).toEqual(expected)
  })

  it('vaultFetchMany with ids fetches chunks and flattens results', async () => {
    trpcMock.items.fetchMany.query.mockResolvedValue(ok({ success: true, items: [{ item: 'a' }, { item: 'b' }] }).data)

    const result = await api.vaultFetchMany({ ids: Array.from({ length: 11 }, (_, index) => String(index + 1)) })
    expect(result).toEqual([{ item: 'a' }, { item: 'b' }])
  })

  it('vaultFetchMany throws when neither cacheTime nor ids provided', async () => {
    await expect(api.vaultFetchMany({} as never)).rejects.toThrow('Must provide cacheTime or ids')
  })

  it('vaultPut succeeds when api returns success', async () => {
    trpcMock.items.put.mutate.mockResolvedValue(ok({ success: true }).data)
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).resolves.toBeUndefined()
  })

  it('vaultPut throws when api request fails', async () => {
    trpcMock.items.put.mutate.mockResolvedValue(ok({ success: false }).data)
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).rejects.toThrow()
  })

  it('vaultPutMany succeeds when all batch items succeed', async () => {
    trpcMock.items.putMany.mutate.mockResolvedValue(ok({
      success: true,
      conflicts: [],
    }).data)
    await expect(api.vaultPutMany({ items: putManyItems })).resolves.toBeUndefined()
  })

  it('vaultPutMany throws with version conflict ids from transactional response', async () => {
    trpcMock.items.putMany.mutate.mockResolvedValue(ok({
      success: false,
      error: 'Version conflict',
      conflicts: ['b'],
    }).data)
    await expect(api.vaultPutMany({ items: putManyItems })).rejects.toThrow('Version conflict for items: b')
  })

  it('vaultPutMany includes all conflicted item ids in error message', async () => {
    trpcMock.items.putMany.mutate.mockResolvedValue(ok({
      success: false,
      error: 'Version conflict',
      conflicts: ['a', 'b'],
    }).data)
    await expect(api.vaultPutMany({ items: putManyItems })).rejects.toThrow('Version conflict for items: a, b')
  })

  it('vaultPutMany supports legacy details response shape', async () => {
    trpcMock.items.putMany.mutate.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: true }, { item: 'b', success: false }],
    }).data)
    await expect(api.vaultPutMany({ items: putManyItems })).rejects.toThrow('failed for items: b')
  })

  it('vaultDelete succeeds when api returns success', async () => {
    trpcMock.items.delete.mutate.mockResolvedValue(ok({ success: true }).data)
    await expect(api.vaultDelete({ item: 'x' })).resolves.toBeUndefined()
  })

  it('vaultDelete throws when api request fails', async () => {
    trpcMock.items.delete.mutate.mockResolvedValue(ok({ success: false }).data)
    await expect(api.vaultDelete({ item: 'x' })).rejects.toThrow()
  })

  it('vaultDeleteMany succeeds when all items in all chunks succeed', async () => {
    trpcMock.items.deleteMany.mutate.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: true }, { item: 'b', success: true }],
    }).data)
    await expect(api.vaultDeleteMany({ items: ['a', 'b'] })).resolves.toBeUndefined()
  })

  it('vaultDeleteMany throws when any item in details fails', async () => {
    trpcMock.items.deleteMany.mutate.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: true }, { item: 'b', success: false }],
    }).data)
    await expect(api.vaultDeleteMany({ items: ['a', 'b'] })).rejects.toThrow('failed for items: b')
  })

  it('vaultDeleteMany includes all failed item ids in error message', async () => {
    trpcMock.items.deleteMany.mutate.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'x', success: false }, { item: 'y', success: false }, { item: 'z', success: true }],
    }).data)
    await expect(api.vaultDeleteMany({ items: ['x', 'y', 'z'] })).rejects.toThrow('failed for items: x, y')
  })

  it('vaultCreateAccount returns account from response', async () => {
    trpcMock.accounts.createAccount.mutate.mockResolvedValue(ok({ account: 'acct1' }).data)
    const res = await api.vaultCreateAccount({ salt: 's', authToken: 't' })
    expect(res).toEqual({ account: 'acct1' })
  })

  it('vaultGetSalt validates response', async () => {
    trpcMock.accounts.getSalt.query.mockResolvedValueOnce(ok({ success: true, salt: 'saltx' }).data)
    await expect(api.vaultGetSalt()).resolves.toBe('saltx')

    trpcMock.accounts.getSalt.query.mockResolvedValueOnce(ok({ success: false }).data)
    await expect(api.vaultGetSalt()).rejects.toThrow()

    trpcMock.accounts.getSalt.query.mockResolvedValueOnce(ok({ success: true, salt: undefined }).data)
    await expect(api.vaultGetSalt()).rejects.toThrow()
  })

  it('vaultGetSession validates response', async () => {
    trpcMock.accounts.login.mutate.mockResolvedValueOnce(ok({ success: true, session: 'sess' }).data)
    await expect(api.vaultGetSession('t')).resolves.toBe('sess')

    trpcMock.accounts.login.mutate.mockResolvedValueOnce(ok({ success: false }).data)
    await expect(api.vaultGetSession('t')).rejects.toThrow()

    trpcMock.accounts.login.mutate.mockResolvedValueOnce(ok({ success: true, session: undefined }).data)
    await expect(api.vaultGetSession('t')).rejects.toThrow()
  })

  it('vaultGetMetadata returns metadata when present', async () => {
    const meta = { prayerGoal: 1 }
    trpcMock.accounts.getMetadata.query.mockResolvedValueOnce(ok({ success: true, metadata: meta }).data)
    const res = await api.vaultGetMetadata()
    expect(res).toEqual(meta)
  })

  it('vaultGetMetadata throws when success is false', async () => {
    trpcMock.accounts.getMetadata.query.mockResolvedValueOnce(ok({ success: false }).data)
    await expect(api.vaultGetMetadata()).rejects.toThrow()
  })

  it('vaultSetMetadata succeeds when api returns success', async () => {
    trpcMock.accounts.updateMetadata.mutate.mockResolvedValue(ok({ success: true }).data)
    await api.vaultSetMetadata({ cipher: 'c', iv: 'i' } as any)
  })

  it('vaultAddPushSubscription and vaultDeletePushSubscription succeed when api returns success', async () => {
    trpcMock.accounts.addPushSubscription.mutate.mockResolvedValue(ok({ success: true }).data)
    trpcMock.accounts.deletePushSubscription.mutate.mockResolvedValue(ok({ success: true }).data)
    await api.vaultAddPushSubscription({ endpoint: 'e', keys: { auth: 'a', p256dh: 'p' } })
    await api.vaultDeletePushSubscription('e')
  })

  it('vaultGetReminderSettings throws on !success and returns response on success', async () => {
    trpcMock.accounts.getReminderSettings.query.mockResolvedValueOnce(ok({ success: false }).data)
    await expect(api.vaultGetReminderSettings()).rejects.toThrow()

    const settings = {
      success: true,
      reminderEnabled: true,
      reminderTime: '08:00',
      reminderTimezone: 'UTC',
    }
    trpcMock.accounts.getReminderSettings.query.mockResolvedValueOnce(ok(settings).data)
    const res = await api.vaultGetReminderSettings()
    expect(res).toEqual(settings)
  })

  it('vaultUpdateReminderSettings and vaultRecordPrayerCompletion succeed', async () => {
    trpcMock.accounts.updateReminderSettings.mutate.mockResolvedValue(ok({ success: true }).data)
    trpcMock.accounts.recordPrayerCompletion.mutate.mockResolvedValue(ok({ success: true }).data)
    await expect(api.vaultUpdateReminderSettings({
      reminderEnabled: true,
      reminderTime: '09:00',
      reminderTimezone: 'Australia/Sydney',
    })).resolves.toBeUndefined()
    await expect(api.vaultRecordPrayerCompletion(123)).resolves.toBeUndefined()
  })
})
