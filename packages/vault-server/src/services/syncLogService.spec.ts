import type { ItemId, SyncLogEntry } from '@vault/shared'
import { pollLog, type SyncRepository } from './syncLogService'

const itemId = 'item-1' as ItemId
const encryptedMessage = { iv: 'iv', cipher: 'cipher', format: 2 as const }
const entry: SyncLogEntry = { seq: 4, itemId, encryptedMessage, createdAt: 1000 }

function createVault() {
  return {
    appendLog: vi.fn<SyncRepository['appendLog']>(async () => [{ itemId, seq: 4 }]),
    readLog: vi.fn<SyncRepository['readLog']>(async () => ({ entries: [entry], hasMore: true })),
  }
}

describe('pollLog', () => {
  it('appends the push, then reads the log, so a poll sees its own rows', async () => {
    const vault = createVault()

    const result = await pollLog(vault, { account: 'acct', push: [{ itemId, encryptedMessage }], after: 3 })

    expect(vault.appendLog).toHaveBeenCalledWith({ account: 'acct', messages: [{ itemId, encryptedMessage }] })
    expect(vault.readLog).toHaveBeenCalledWith({ account: 'acct', after: 3 })
    expect(vault.appendLog.mock.invocationCallOrder[0]).toBeLessThan(vault.readLog.mock.invocationCallOrder[0])
    expect(result).toEqual({
      pushResults: [{ itemId, seq: 4 }],
      entries: [entry],
      hasMore: true,
      serverNow: expect.any(Number),
    })
  })

  it('appends nothing for an empty push', async () => {
    const vault = createVault()

    const result = await pollLog(vault, { account: 'acct', push: [], after: 0 })

    expect(vault.appendLog).not.toHaveBeenCalled()
    expect(result.pushResults).toEqual([])
  })

  it('reads nothing when the push fails', async () => {
    const vault = createVault()
    vault.appendLog.mockRejectedValue(new Error('Append failed'))

    await expect(pollLog(vault, { account: 'acct', push: [{ itemId, encryptedMessage }], after: 0 }))
      .rejects.toThrow('Append failed')
    expect(vault.readLog).not.toHaveBeenCalled()
  })

  it('reads the clock after the log, so no row looks newer than serverNow', async () => {
    const vault = createVault()
    let createdAt = 0
    vault.readLog.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      createdAt = Date.now()
      return { entries: [{ ...entry, createdAt }], hasMore: false }
    })

    const { serverNow } = await pollLog(vault, { account: 'acct', push: [], after: 0 })

    expect(serverNow).toBeGreaterThanOrEqual(createdAt)
  })
})
