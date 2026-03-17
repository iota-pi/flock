import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from './VaultAPI'
import * as util from './util'

const apiClientMock = vi.hoisted(() => ({
  DELETE: vi.fn(),
  GET: vi.fn(),
  PATCH: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
}))

vi.mock('./client', async importOriginal => {
  const actual = await importOriginal<typeof import('./client')>()
  return {
    ...actual,
    apiClient: apiClientMock,
  }
})

function ok<T>(data: T) {
  return {
    data,
    response: new Response(null, { status: 200 }),
  }
}

function notOk(error?: unknown, status = 500) {
  return {
    error,
    response: new Response(null, { status }),
  }
}

describe('VaultAPI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(util, 'getAccountId').mockReturnValue('acct1')
    Object.values(apiClientMock).forEach(mockFn => mockFn.mockReset())
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('vaultFetchMany with cacheTime returns items', async () => {
    const expected = [{ item: 'a', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } }]
    apiClientMock.GET.mockResolvedValue(ok({ success: true, items: expected }))

    const result = await api.vaultFetchMany({ cacheTime: 123 })
    expect(result).toEqual(expected)
  })

  it('vaultFetchMany with ids fetches chunks and flattens results', async () => {
    apiClientMock.GET
      .mockResolvedValueOnce(ok({ success: true, items: [{ item: 'a' }] }))
      .mockResolvedValueOnce(ok({ success: true, items: [{ item: 'b' }] }))

    const result = await api.vaultFetchMany({ ids: Array.from({ length: 11 }, (_, index) => String(index + 1)) })
    expect(result).toEqual([{ item: 'a' }, { item: 'b' }])
  })

  it('vaultFetchMany throws when neither cacheTime nor ids provided', async () => {
    await expect(api.vaultFetchMany({} as never)).rejects.toThrow('Must provide cacheTime or ids')
  })

  it('vaultPut succeeds when api returns success', async () => {
    apiClientMock.PUT.mockResolvedValue(ok({ success: true }))
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).resolves.toBeUndefined()
  })

  it('vaultPut throws when api request fails', async () => {
    apiClientMock.PUT.mockResolvedValue(notOk())
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).rejects.toThrow()
  })

  it('vaultPutMany succeeds when all batch items succeed', async () => {
    apiClientMock.PUT.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: true }, { item: 'b', success: true }],
    }))
    await expect(api.vaultPutMany({ items: [{ item: 'a' }, { item: 'b' }] as any })).resolves.toBeUndefined()
  })

  it('vaultPutMany throws when any item in details fails', async () => {
    apiClientMock.PUT.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: true }, { item: 'b', success: false }],
    }))
    await expect(api.vaultPutMany({ items: [{ item: 'a' }, { item: 'b' }] as any })).rejects.toThrow('failed for items: b')
  })

  it('vaultPutMany includes all failed item ids in error message', async () => {
    apiClientMock.PUT.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: false }, { item: 'b', success: false }],
    }))
    await expect(api.vaultPutMany({ items: [{ item: 'a' }, { item: 'b' }] as any })).rejects.toThrow('failed for items: a, b')
  })

  it('vaultDelete succeeds when api returns success', async () => {
    apiClientMock.DELETE.mockResolvedValue(ok({ success: true }))
    await expect(api.vaultDelete({ item: 'x' })).resolves.toBeUndefined()
  })

  it('vaultDelete throws when api request fails', async () => {
    apiClientMock.DELETE.mockResolvedValue(notOk())
    await expect(api.vaultDelete({ item: 'x' })).rejects.toThrow()
  })

  it('vaultDeleteMany succeeds when all items in all chunks succeed', async () => {
    apiClientMock.DELETE.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: true }, { item: 'b', success: true }],
    }))
    await expect(api.vaultDeleteMany({ items: ['a', 'b'] })).resolves.toBeUndefined()
  })

  it('vaultDeleteMany throws when any item in details fails', async () => {
    apiClientMock.DELETE.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'a', success: true }, { item: 'b', success: false }],
    }))
    await expect(api.vaultDeleteMany({ items: ['a', 'b'] })).rejects.toThrow('failed for items: b')
  })

  it('vaultDeleteMany includes all failed item ids in error message', async () => {
    apiClientMock.DELETE.mockResolvedValue(ok({
      success: true,
      details: [{ item: 'x', success: false }, { item: 'y', success: false }, { item: 'z', success: true }],
    }))
    await expect(api.vaultDeleteMany({ items: ['x', 'y', 'z'] })).rejects.toThrow('failed for items: x, y')
  })

  it('vaultCreateAccount returns account from response', async () => {
    apiClientMock.POST.mockResolvedValue(ok({ account: 'acct1' }))
    const res = await api.vaultCreateAccount({ salt: 's', authToken: 't' })
    expect(res).toEqual({ account: 'acct1' })
  })

  it('vaultGetSalt validates response', async () => {
    apiClientMock.GET.mockResolvedValueOnce(ok({ success: true, salt: 'saltx' }))
    await expect(api.vaultGetSalt()).resolves.toBe('saltx')

    apiClientMock.GET.mockResolvedValueOnce(ok({ success: false }))
    await expect(api.vaultGetSalt()).rejects.toThrow()

    apiClientMock.GET.mockResolvedValueOnce(ok({ success: true, salt: undefined }))
    await expect(api.vaultGetSalt()).rejects.toThrow()
  })

  it('vaultGetSession validates response', async () => {
    apiClientMock.POST.mockResolvedValueOnce(ok({ success: true, session: 'sess' }))
    await expect(api.vaultGetSession('t')).resolves.toBe('sess')

    apiClientMock.POST.mockResolvedValueOnce(ok({ success: false }))
    await expect(api.vaultGetSession('t')).rejects.toThrow()

    apiClientMock.POST.mockResolvedValueOnce(ok({ success: true, session: undefined }))
    await expect(api.vaultGetSession('t')).rejects.toThrow()
  })

  it('vaultGetMetadata returns metadata when present', async () => {
    const meta = { prayerGoal: 1 }
    apiClientMock.GET.mockResolvedValueOnce(ok({ success: true, metadata: meta }))
    const res = await api.vaultGetMetadata()
    expect(res).toEqual(meta)
  })

  it('vaultGetMetadata throws when success is false', async () => {
    apiClientMock.GET.mockResolvedValueOnce(ok({ success: false }))
    await expect(api.vaultGetMetadata()).rejects.toThrow()
  })

  it('vaultSetMetadata succeeds when api returns success', async () => {
    apiClientMock.PATCH.mockResolvedValue(ok({ success: true }))
    await api.vaultSetMetadata({ cipher: 'c', iv: 'i' } as any)
  })

  it('vaultAddPushSubscription and vaultDeletePushSubscription succeed when api returns success', async () => {
    apiClientMock.POST.mockResolvedValue(ok({ success: true }))
    apiClientMock.DELETE.mockResolvedValue(ok({ success: true }))
    await api.vaultAddPushSubscription({ endpoint: 'e', keys: { auth: 'a', p256dh: 'p' } })
    await api.vaultDeletePushSubscription('e')
  })

  it('vaultGetReminderSettings throws on !success and returns response on success', async () => {
    apiClientMock.GET.mockResolvedValueOnce(ok({ success: false }))
    await expect(api.vaultGetReminderSettings()).rejects.toThrow()

    const settings = {
      success: true,
      reminderEnabled: true,
      reminderTime: '08:00',
      reminderTimezone: 'UTC',
    }
    apiClientMock.GET.mockResolvedValueOnce(ok(settings))
    const res = await api.vaultGetReminderSettings()
    expect(res).toEqual(settings)
  })

  it('vaultUpdateReminderSettings and vaultRecordPrayerCompletion succeed', async () => {
    apiClientMock.POST.mockResolvedValue(ok({ success: true }))
    await expect(api.vaultUpdateReminderSettings({
      reminderEnabled: true,
      reminderTime: '09:00',
      reminderTimezone: 'Australia/Sydney',
    })).resolves.toBeUndefined()
    await expect(api.vaultRecordPrayerCompletion(123)).resolves.toBeUndefined()
  })
})
