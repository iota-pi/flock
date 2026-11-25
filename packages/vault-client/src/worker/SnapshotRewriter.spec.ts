import { MAX_REWRITE_ATTEMPTS, SnapshotRewriter, type SnapshotRewriterOptions } from './SnapshotRewriter'
import { SnapshotPusher } from './SnapshotPusher'
import type { SnapshotSchedule } from './SnapshotSchedule'
import type { ItemId } from '@vault/shared'
import type { StoredSnapshotDetails } from './snapshotUpload'
import type { Mock } from 'vitest'
import { RecoveryManager } from './RecoveryManager'
import { ClientEventHub } from './SyncEventHub'
import { passthroughCodec } from './domain'
import { SnapshotBuilder } from './SnapshotBuilder'
import { SyncApiClient } from './SyncApiClient'
import { SyncSessionState } from './SyncSessionState'
import { upsertManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { createMockKeyProvider, createMockVault, noLogCoverage, spyOnVaultTrpc } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import { getApiAuthToken, setApiAuthToken } from '../keys/runtime'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as docStoreModule from './docStore'
import * as automergeModule from './utils/automerge'
import * as Automerge from '@automerge/automerge/slim'

const mockPutSnapshots = vi.fn()
const mockListItemIds = vi.fn()

const vault = {
  ...createMockVault(),
  encryptBytes: vi.fn().mockResolvedValue({
    iv: 'mock-iv',
    cipher: 'mock-cipher',
    kver: '1',
  }),
}
const keys = createMockKeyProvider(vault)

/** Fills in what the server always returns: a successful batch stores every snapshot, at version 1 */
async function withSnapshotResults(input: any, response: any) {
  const resolved = await response
  if (!resolved) {
    return resolved
  }
  const persisted = resolved.persisted ?? (resolved.success ? input.snapshots.length : 0)
  const results = resolved.results
    ?? (persisted === input.snapshots.length ? input.snapshots.map((s: any) => ({ itemId: s.itemId, version: 1 })) : [])
  return { ...resolved, persisted, results }
}

/** The rewriter's options, and what the snapshot pusher it uploads through is made from */
interface TestDeps extends Omit<SnapshotRewriterOptions, 'runPollNow' | 'uploader' | 'apiClient'> {
  apiClient: SyncApiClient
  builder: Pick<SnapshotBuilder, 'build'>
  pushToLog: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
  recoveryManager: RecoveryManager
  schedule: ReturnType<typeof createSchedule>
  onSnapshotStored: Mock<(details: StoredSnapshotDetails) => void>
  maxPayloadBytes?: number
  runPollNow?: () => Promise<void>
}

/** The parts of the schedule a rewrite reaches, with no item dirty */
function createSchedule() {
  return {
    getDirtyTick: vi.fn<(itemId: ItemId) => number | undefined>(() => undefined),
    recordSnapshotSuccess: vi.fn(),
    recordOversized: vi.fn(() => true),
    clearOversized: vi.fn(),
    removeDirtyItemIfTickMatches: vi.fn(),
  }
}

/** The snapshot pusher whose pipeline the rewriter runs */
function createUploader(deps: TestDeps): SnapshotPusher {
  return new SnapshotPusher({
    accountId: 'test-account',
    session: deps.session,
    schedule: deps.schedule as unknown as SnapshotSchedule,
    state: { flushPendingSave: vi.fn() },
    builder: deps.builder,
    pushToLog: deps.pushToLog,
    onSnapshotStored: deps.onSnapshotStored,
    recoveryManager: deps.recoveryManager,
    apiClient: deps.apiClient,
    eventHub: new ClientEventHub(),
    maxPayloadBytes: deps.maxPayloadBytes,
    runPollNow: vi.fn().mockResolvedValue(undefined),
    isCaughtUp: () => true,
    hasPendingMarks: vi.fn().mockResolvedValue(false),
  })
}

/**
 * A rewriter whose `runPollNow` runs polls one after another, as the orchestrator does, each running
 * the rewrite phase. `outcomes` records whether each poll's phase succeeded or threw.
 */
function createRewriter(deps: TestDeps) {
  const outcomes: Array<'success' | 'failure'> = []
  const polled: { rewriter?: SnapshotRewriter } = {}
  let lastPoll = Promise.resolve()
  const poll = () => {
    lastPoll = lastPoll.then(async () => {
      const target = polled.rewriter!
      try {
        await target.runDue(new AbortController().signal)
        outcomes.push('success')
      } catch (error) {
        // As `SyncPoller.executePoll` does
        target.onPollStopped(error)
        outcomes.push('failure')
      }
    })
    return lastPoll
  }
  const rewriter = new SnapshotRewriter({ runPollNow: poll, ...deps, uploader: createUploader(deps) })
  polled.rewriter = rewriter
  return { rewriter, outcomes, poll }
}

function createDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  const mockRepo = {
    find: vi.fn().mockResolvedValue({
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
    }),
  }
  return {
    builder: new SnapshotBuilder(mockRepo as any, keys, passthroughCodec, noLogCoverage),
    indexManager: { listItemIds: () => mockListItemIds() },
    apiClient: new SyncApiClient(),
    recoveryManager: new RecoveryManager({ accountId: 'test-account', eventHub: new ClientEventHub() }),
    session: new SyncSessionState({ isLeader: true }),
    claimLeader: vi.fn(),
    catchUp: { isCaughtUp: true, whenCaughtUp: vi.fn().mockResolvedValue(undefined) },
    pushToLog: vi.fn().mockResolvedValue(undefined),
    schedule: createSchedule(),
    onSnapshotStored: vi.fn(),
    ...overrides,
  }
}

/** A builder that finds each document through `find`, so a test can make some items fail */
function builderWith(find: (url: string) => Promise<unknown>) {
  return new SnapshotBuilder({ find } as any, keys, passthroughCodec, noLogCoverage)
}

const readyDoc = { isReady: () => true, doc: () => ({ id: 'item-doc', type: 'note' }) }

beforeEach(() => {
  vi.clearAllMocks()
  setApiAuthToken('mock-token')
  spyOnVaultTrpc({
    putSnapshots: (...args: any[]) => withSnapshotResults(args[0], mockPutSnapshots(...args)),
  })
  spyOnExports(manualRecoveryStoreModule, {
    upsertManualRecoveryEntry: vi.fn().mockResolvedValue({ id: 'mock-entry' }),
  })
  spyOnExports(docStoreModule, {
    normalizeItemSnapshot: vi.fn().mockReturnValue({
      type: 'note',
      deleted: false,
    }),
  })
  spyOnExports(automergeModule, {
    toAutomergeUrlFromItemId: vi.fn().mockImplementation((id: string) => `automerge:${id}`),
  })
  spyOnExports(Automerge, {
    save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    getHeads: vi.fn().mockReturnValue(['mock-head']),
  })
})

describe('SnapshotRewriter.request', () => {
  let deps: TestDeps
  let rewriter: SnapshotRewriter
  let outcomes: Array<'success' | 'failure'>

  beforeEach(() => {
    deps = createDeps()
    ;({ rewriter, outcomes } = createRewriter(deps))
  })

  afterEach(() => {
    rewriter.cancel()
  })

  it('throws an error if there is no session token', async () => {
    setApiAuthToken('')
    await expect(rewriter.request()).rejects.toThrow('No active session token available')
  })

  it('handles an empty item list without a poll', async () => {
    mockListItemIds.mockResolvedValue([])

    const onProgress = vi.fn()
    const result = await rewriter.request({ onProgress })

    expect(result).toEqual({ succeeded: [], failed: [] })
    expect(onProgress).toHaveBeenCalledWith(0, 0)
    expect(mockPutSnapshots).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(outcomes).toEqual([]))
  })

  it('uploads the items in a poll', async () => {
    mockListItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshots.mockResolvedValue({ success: true })

    const onProgress = vi.fn()
    const result = await rewriter.request({ onProgress })

    expect(result).toEqual({ succeeded: ['item-1', 'item-2'], failed: [] })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(mockPutSnapshots).toHaveBeenCalledWith(
      {
        account: 'test-account',
        snapshots: [
          expect.objectContaining({ itemId: 'item-1' }),
          expect.objectContaining({ itemId: 'item-2' }),
        ],
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(onProgress).toHaveBeenCalledWith(2, 2)
    await vi.waitFor(() => expect(outcomes).toEqual(['success']))
    expect(rewriter.stage).toBeNull()
    expect(rewriter.pendingCount).toBe(0)
  })

  it('quarantines the items of a batch the server only partly stored, after its attempts', async () => {
    mockListItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })

    const result = await rewriter.request()

    expect(mockPutSnapshots).toHaveBeenCalledTimes(MAX_REWRITE_ATTEMPTS)
    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([
      { itemId: 'item-1', error: expect.stringContaining('Failed to upload the snapshot') },
      { itemId: 'item-2', error: expect.stringContaining('Failed to upload the snapshot') },
    ])
    expect(upsertManualRecoveryEntry).toHaveBeenCalledTimes(2)
  })

  it('records the versions and heads of the snapshots the server stored', async () => {
    mockListItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshots.mockResolvedValue({
      success: true,
      persisted: 2,
      results: [{ itemId: 'item-1', version: 4 }, { itemId: 'item-2', version: 9 }],
    })

    await rewriter.request()

    expect(deps.schedule.recordSnapshotSuccess).toHaveBeenCalledWith('item-1', undefined, 4)
    expect(deps.schedule.recordSnapshotSuccess).toHaveBeenCalledWith('item-2', undefined, 9)
    expect(deps.onSnapshotStored).toHaveBeenCalledWith({ itemId: 'item-1', heads: ['mock-head'] })
    expect(deps.onSnapshotStored).toHaveBeenCalledWith({ itemId: 'item-2', heads: ['mock-head'] })
  })

  it('uploads a dirty item with its tick, so the stored snapshot takes it out of the queue', async () => {
    deps.schedule.getDirtyTick.mockImplementation(itemId => (itemId === 'item-1' ? 7 : undefined))
    mockListItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshots.mockResolvedValue({ success: true })

    await rewriter.request()

    expect(deps.schedule.recordSnapshotSuccess).toHaveBeenCalledWith('item-1', 7, 1)
    expect(deps.schedule.recordSnapshotSuccess).toHaveBeenCalledWith('item-2', undefined, 1)
  })

  it('retries only the items the server didn\'t store', async () => {
    mockListItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshots.mockResolvedValue({
      success: true,
      persisted: 1,
      results: [{ itemId: 'item-2', version: 3 }],
    })

    const result = await rewriter.request()

    expect(mockPutSnapshots).toHaveBeenCalledTimes(MAX_REWRITE_ATTEMPTS)
    expect(mockPutSnapshots.mock.calls[1][0].snapshots.map((s: any) => s.itemId)).toEqual(['item-1'])
    expect(deps.onSnapshotStored).toHaveBeenCalledTimes(1)
    expect(result.succeeded).toEqual(['item-2'])
    expect(result.failed).toEqual([
      { itemId: 'item-1', error: expect.stringContaining('Failed to upload the snapshot') },
    ])
    expect(upsertManualRecoveryEntry).toHaveBeenCalledTimes(1)
  })

  it('records failed items and quarantines them if the server stores none', async () => {
    mockListItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshots.mockResolvedValue({ success: false })

    const result = await rewriter.request()

    expect(result).toEqual({
      succeeded: [],
      failed: [{ itemId: 'item-1', error: expect.stringContaining('Failed to upload the snapshot') }],
    })
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-1',
      kind: 'snapshotFailure',
      detail: { code: 'snapshotFailed', stage: 'upload' },
    })
    // Item failures aren't the poll's
    await vi.waitFor(() => expect(outcomes).toEqual(['success']))
  })

  it('goes on with the other chunks when one chunk\'s batch keeps failing', async () => {
    // 12 items: a chunk of 10 and a chunk of 2
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`)
    mockListItemIds.mockResolvedValue(items)
    mockPutSnapshots.mockImplementation(async (input: any) => ({
      success: !input.snapshots.some((s: any) => s.itemId === 'item-0'),
    }))

    const onProgress = vi.fn()
    const result = await rewriter.request({ onProgress })

    // Items queued again share batches with the next ones, so only item-0's batches fail
    expect(result.succeeded).toEqual(expect.arrayContaining(['item-10', 'item-11']))
    expect(result.failed.map(f => f.itemId)).toContain('item-0')
    expect(result.succeeded.length + result.failed.length).toBe(12)
    expect(onProgress).toHaveBeenLastCalledWith(12, 12)
  })

  it('quarantines an item whose build fails, uploading the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockListItemIds.mockResolvedValue(['item-1', 'item-bad', 'item-2'])
    mockPutSnapshots.mockResolvedValue({ success: true })
    let badItemAttempts = 0
    const { rewriter: failing } = createRewriter({
      ...deps,
      builder: builderWith(async url => {
        if (url !== 'automerge:item-bad') return readyDoc
        badItemAttempts += 1
        return { isReady: () => true, doc: () => { throw new Error('Corrupt document') } }
      }),
    })

    const onProgress = vi.fn()
    const result = await failing.request({ onProgress })

    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(result.failed).toEqual([
      { itemId: 'item-bad', error: expect.stringContaining('Corrupt document') },
    ])
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-bad',
      kind: 'snapshotFailure',
      detail: { code: 'snapshotFailed', stage: 'build' },
    })
    expect(badItemAttempts).toBe(MAX_REWRITE_ATTEMPTS)
    expect(mockPutSnapshots.mock.calls[0][0].snapshots.map((s: any) => s.itemId)).toEqual(['item-1', 'item-2'])
    expect(onProgress).toHaveBeenLastCalledWith(3, 3)
  })

  it('reports why a build failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockListItemIds.mockResolvedValue(['item-bad-doc'])
    const { rewriter: failing } = createRewriter({
      ...deps,
      builder: builderWith(async () => ({ isReady: () => true, doc: () => null })),
    })

    const result = await failing.request()

    expect(result.failed).toEqual([{
      itemId: 'item-bad-doc',
      error: 'Failed to build snapshot for item item-bad-doc: Document data not available',
    }])
    expect(mockPutSnapshots).not.toHaveBeenCalled()
  })

  it('builds a document that wasn\'t ready again, in the same poll', async () => {
    mockListItemIds.mockResolvedValue(['item-retry'])
    mockPutSnapshots.mockResolvedValue({ success: true })
    let attempts = 0
    const { rewriter: retrying, outcomes: pollOutcomes } = createRewriter({
      ...deps,
      builder: builderWith(async () => {
        attempts += 1
        return attempts === 1 ? { isReady: () => false, doc: () => null } : readyDoc
      }),
    })

    const result = await retrying.request()

    expect(attempts).toBe(2)
    expect(result).toEqual({ succeeded: ['item-retry'], failed: [] })
    await vi.waitFor(() => expect(pollOutcomes).toEqual(['success']))
  })

  // Nothing is wrong with it, so a later rewrite can retry it, as the snapshot phase would
  it('gives up on a document that never becomes ready without quarantining it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockListItemIds.mockResolvedValue(['item-never'])
    const { rewriter: retrying } = createRewriter({
      ...deps,
      builder: builderWith(async () => ({ isReady: () => false, doc: () => null })),
    })

    const result = await retrying.request()

    expect(result.failed).toEqual([{
      itemId: 'item-never',
      error: 'Failed to build snapshot for item item-never: document or vault was not ready',
    }])
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('logs and goes on if quarantining a failed item fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockListItemIds.mockResolvedValue(['item-bad-storage'])
    vi.mocked(upsertManualRecoveryEntry).mockRejectedValueOnce(new Error('IndexedDB disk full'))
    const { rewriter: failing } = createRewriter({
      ...deps,
      builder: builderWith(async () => ({ isReady: () => true, doc: () => null })),
    })

    const result = await failing.request()

    expect(result.failed.map(f => f.itemId)).toEqual(['item-bad-storage'])
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[SnapshotPusher] Failed to record manual recovery entry',
      expect.any(Error),
    )
  })

  it('picks up a new auth token between batches', async () => {
    mockListItemIds.mockResolvedValue(Array.from({ length: 12 }, (_, i) => `item-${i}`))
    setApiAuthToken('token-1')
    const tokensSent: string[] = []
    mockPutSnapshots.mockImplementation(async () => {
      tokensSent.push(getApiAuthToken())
      setApiAuthToken('token-2')
      return { success: true }
    })

    const result = await rewriter.request()

    expect(result.succeeded).toHaveLength(12)
    expect(tokensSent).toEqual(['token-1', 'token-2'])
  })

  it('recovers from a 401 with refreshAuthToken', async () => {
    setApiAuthToken('old-token')
    mockListItemIds.mockResolvedValue(['item-1'])
    const refreshAuthToken = vi.fn().mockImplementation(async () => {
      setApiAuthToken('refreshed-token')
      return 'refreshed-token'
    })
    const { rewriter: refreshing } = createRewriter({ ...deps, apiClient: new SyncApiClient({ refreshAuthToken }) })
    mockPutSnapshots
      .mockRejectedValueOnce({ data: { httpStatus: 401 }, message: 'UNAUTHORIZED' })
      .mockResolvedValueOnce({ success: true })

    const result = await refreshing.request()

    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ succeeded: ['item-1'], failed: [] })
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('gets a token via refreshAuthToken if the worker has none', async () => {
    setApiAuthToken('')
    const refreshAuthToken = vi.fn().mockImplementation(async () => {
      setApiAuthToken('recovered-token')
      return 'recovered-token'
    })
    mockListItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshots.mockResolvedValue({ success: true })
    const { rewriter: refreshing } = createRewriter({ ...deps, apiClient: new SyncApiClient({ refreshAuthToken }) })

    const result = await refreshing.request()

    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    expect(result.succeeded).toEqual(['item-1'])
  })

  // The poll reports an auth failure, so the rewrite pauses with polling
  it('fails the poll, quarantining nothing, when the session has expired', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockListItemIds.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `item-${i}`))
    setApiAuthToken('expired-token')
    mockPutSnapshots.mockRejectedValue({ data: { httpStatus: 401 }, message: 'UNAUTHORIZED' })

    await expect(rewriter.request()).rejects.toThrow(/session expired.*UNAUTHORIZED/i)

    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(outcomes).toEqual(['failure']))
    expect(rewriter.pendingCount).toBe(20)
  })

  describe('request failures', () => {
    it.each([
      ['a network error', new TypeError('Failed to fetch'), /Re-encryption aborted: network error/],
      ['an HTTP 500', { data: { httpStatus: 500, code: 'INTERNAL_SERVER_ERROR' }, message: 'Internal server error' }, /Re-encryption aborted: server error/],
      ['a tRPC INTERNAL_SERVER_ERROR', { code: 'INTERNAL_SERVER_ERROR', message: 'Server error' }, /Re-encryption aborted: server error/],
      ['a 503', { status: 503, message: 'Service Unavailable' }, /Re-encryption aborted: server error/],
    ])('fails the poll on %s, quarantining nothing and keeping the rest queued', async (_name, error, message) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockListItemIds.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `item-${i}`))
      mockPutSnapshots.mockRejectedValue(error)

      await expect(rewriter.request()).rejects.toThrow(message)

      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(outcomes).toEqual(['failure']))
      expect(rewriter.pendingCount).toBe(20)
      expect(rewriter.stage).toBe('reencrypting')
    })

    it('goes on with what\'s left at the next poll, without uploading what was done again', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const items = Array.from({ length: 12 }, (_, i) => `item-${i}`)
      mockListItemIds.mockResolvedValue(items)
      mockPutSnapshots
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue({ success: true })
      const { rewriter: resuming, outcomes: pollOutcomes, poll } = createRewriter(deps)

      await expect(resuming.request()).rejects.toThrow(/network error/)
      expect(resuming.pendingCount).toBe(2)

      await poll()

      await vi.waitFor(() => expect(pollOutcomes).toEqual(['failure', 'success']))
      expect(mockPutSnapshots).toHaveBeenCalledTimes(3)
      expect(mockPutSnapshots.mock.calls[2][0].snapshots.map((s: any) => s.itemId)).toEqual(['item-10', 'item-11'])
      expect(resuming.pendingCount).toBe(0)
      expect(resuming.stage).toBeNull()
    })

    it('stops, quarantining nothing, when the server refuses this build', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      const refused = { message: 'CLIENT_OUTDATED', data: { code: 'PRECONDITION_FAILED', httpStatus: 412 } }
      mockPutSnapshots.mockRejectedValue(refused)

      await expect(rewriter.request()).rejects.toBe(refused)

      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    })

    it('stops, quarantining nothing, when the server refuses a push while building', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      const refused = { message: 'CLIENT_OUTDATED', data: { code: 'PRECONDITION_FAILED', httpStatus: 412 } }
      const builder = { build: vi.fn().mockResolvedValue({ type: 'deferred', reason: 'unpushed' }) }
      const pushToLog = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(refused)
      const { rewriter: refusing } = createRewriter({ ...deps, builder, pushToLog })

      await expect(refusing.request()).rejects.toBe(refused)

      expect(builder.build).toHaveBeenCalledTimes(1)
      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('fails the poll when the chunk\'s push fails on the network', async () => {
      mockListItemIds.mockResolvedValue(['item-1'])
      vi.mocked(deps.pushToLog).mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(rewriter.request()).rejects.toThrow('Failed to fetch')

      await vi.waitFor(() => expect(outcomes).toEqual(['failure']))
      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('quarantines an item whose upload fails for good, apart from network and server errors', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      mockListItemIds.mockResolvedValue(['item-perm-fail'])
      mockPutSnapshots.mockRejectedValue({ data: { httpStatus: 400 }, message: 'Bad Request: Invalid snapshot schema' })

      const result = await rewriter.request()

      expect(result.failed.map(f => f.itemId)).toEqual(['item-perm-fail'])
      expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
        itemId: 'item-perm-fail',
        kind: 'snapshotFailure',
        detail: { code: 'snapshotFailed', stage: 'upload' },
      })
      await vi.waitFor(() => expect(outcomes).toEqual(['success']))
    })
  })

  it('pushes a deferred item and builds again, leaving it for a later rewrite after the limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockListItemIds.mockResolvedValue(['item-1'])
    const builder = { build: vi.fn().mockResolvedValue({ type: 'deferred', reason: 'unpushed' }) }
    const { rewriter: deferring } = createRewriter({ ...deps, builder })

    const result = await deferring.request()

    // Each attempt builds, pushes the item, and builds again
    expect(builder.build).toHaveBeenCalledTimes(2 * MAX_REWRITE_ATTEMPTS)
    expect(vi.mocked(deps.pushToLog)).toHaveBeenCalledWith(['item-1'], expect.any(AbortSignal))
    expect(result.failed).toEqual([{ itemId: 'item-1', error: expect.stringContaining('wait for the log') }])
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('splits a chunk into batches by size', async () => {
    mockListItemIds.mockResolvedValue(['item-1', 'item-2', 'item-3'])
    mockPutSnapshots.mockResolvedValue({ success: true })
    // Each mock snapshot is about 150 bytes, so a batch holds one
    const { rewriter: small } = createRewriter({ ...deps, maxPayloadBytes: 200 })

    const result = await small.request()

    expect(result).toEqual({ succeeded: ['item-1', 'item-2', 'item-3'], failed: [] })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(3)
    for (const [input] of mockPutSnapshots.mock.calls) {
      expect(input.snapshots).toHaveLength(1)
    }
  })

  it('fails an oversized item at once, quarantining it as oversized as the snapshot phase does', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockListItemIds.mockResolvedValue(['item-1'])
    // Each mock snapshot is about 150 bytes
    const { rewriter: small } = createRewriter({ ...deps, maxPayloadBytes: 100 })

    const result = await small.request()

    expect(result.failed).toEqual([{ itemId: 'item-1', error: expect.stringContaining('exceeds the') }])
    expect(mockPutSnapshots).not.toHaveBeenCalled()
    expect(deps.schedule.recordOversized).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-1',
      kind: 'oversized',
      detail: { code: 'oversized', sizeKb: 0 },
    }))
  })

  it('claims leadership first when this tab is a follower', async () => {
    mockListItemIds.mockResolvedValue([])
    const session = new SyncSessionState()
    const claimLeader = vi.fn(() => session.setLeader(true))
    const { rewriter: following } = createRewriter({ ...deps, session, claimLeader })

    await following.request()

    expect(claimLeader).toHaveBeenCalledTimes(1)
  })

  it('stops at once, quarantining nothing, while offline', async () => {
    mockListItemIds.mockResolvedValue(['item-1'])
    deps.session.setOnline(false)

    await expect(rewriter.request()).rejects.toThrow(/Re-encryption aborted: network error \(offline\)/)

    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
    expect(mockPutSnapshots).not.toHaveBeenCalled()
  })

  it('rejects a caller when no poll can run, keeping the rewrite queued', async () => {
    mockListItemIds.mockResolvedValue(['item-1'])
    const { rewriter: skipped } = createRewriter({
      ...deps,
      runPollNow: async () => { deps.session.setOnline(false) },
    })

    await expect(skipped.request()).rejects.toThrow('could not run')

    expect(skipped.pendingCount).toBe(1)
    skipped.cancel()
  })

  it('rejects its callers when a poll stops before the rewrite phase, keeping the rewrite queued', async () => {
    mockListItemIds.mockResolvedValue(['item-1'])
    const pollFailure = new TypeError('Failed to fetch')
    const { rewriter: stopped } = createRewriter({
      ...deps,
      runPollNow: async () => { stopped.onPollStopped(pollFailure) },
    })

    await expect(stopped.request()).rejects.toThrow(/Re-encryption aborted: network error/)

    expect(stopped.pendingCount).toBe(1)
    expect(stopped.stage).toBe('reencrypting')
    stopped.cancel()
  })
})

describe('SnapshotRewriter.runDue', () => {
  beforeEach(() => {
    mockListItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshots.mockResolvedValue({ success: true })
  })

  it('does nothing with nothing queued', async () => {
    const { rewriter } = createRewriter(createDeps())

    await rewriter.runDue(new AbortController().signal)

    expect(mockPutSnapshots).not.toHaveBeenCalled()
  })

  it('leaves the queue until the device has caught up, as the snapshot phase does', async () => {
    const catchUp = { isCaughtUp: true, whenCaughtUp: vi.fn().mockResolvedValue(undefined) }
    const { rewriter } = createRewriter({ ...createDeps({ catchUp }), runPollNow: async () => {} })
    const request = rewriter.request()
    await vi.waitFor(() => expect(rewriter.pendingCount).toBe(1))
    catchUp.isCaughtUp = false

    await rewriter.runDue(new AbortController().signal)
    expect(mockPutSnapshots).not.toHaveBeenCalled()

    catchUp.isCaughtUp = true
    await rewriter.runDue(new AbortController().signal)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(rewriter.pendingCount).toBe(0)
    expect(await request).toEqual({ succeeded: ['item-1'], failed: [] })
  })

  it('stops when the poll is aborted, keeping the rest queued', async () => {
    const { rewriter } = createRewriter({ ...createDeps(), runPollNow: async () => {} })
    const request = rewriter.request()
    await vi.waitFor(() => expect(rewriter.pendingCount).toBe(1))
    const controller = new AbortController()
    controller.abort()

    await expect(rewriter.runDue(controller.signal)).rejects.toThrow()

    await expect(request).rejects.toThrow()
    expect(mockPutSnapshots).not.toHaveBeenCalled()
    expect(rewriter.pendingCount).toBe(1)
    rewriter.cancel()
  })
})

describe('SnapshotRewriter waits', () => {
  beforeEach(() => {
    mockListItemIds.mockResolvedValue([])
  })

  it('gives up waiting for leadership after the timeout, reporting the stage', async () => {
    const onStage = vi.fn()
    const session = new SyncSessionState()
    const { rewriter } = createRewriter(createDeps({ session, onStage }))

    await expect(rewriter.request({ waitTimeoutMs: 10 })).rejects.toMatchObject({
      name: 'ReencryptionWaitError',
      stage: 'waitingForLeader',
    })

    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['waitingForLeader', null])
    expect(rewriter.stage).toBeNull()
    session.setLeader(true)
  })

  it('waits until the device has caught up, so it never replaces a snapshot it has not merged', async () => {
    mockListItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshots.mockResolvedValue({ success: true })
    let catchUpDone!: () => void
    const catchUp = {
      isCaughtUp: false,
      whenCaughtUp: vi.fn(() => new Promise<void>(resolve => {
        catchUpDone = () => {
          catchUp.isCaughtUp = true
          resolve()
        }
      })),
    }
    const onStage = vi.fn()
    const { rewriter } = createRewriter(createDeps({ catchUp, onStage }))

    const running = rewriter.request()
    await vi.waitFor(() => expect(onStage).toHaveBeenCalledWith('waitingForSync'))
    expect(mockListItemIds).not.toHaveBeenCalled()
    catchUpDone()

    await expect(running).resolves.toEqual({ succeeded: ['item-1'], failed: [] })
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['waitingForSync', 'reencrypting', null])
  })

  it('gives up waiting to catch up after the timeout', async () => {
    const catchUp = { isCaughtUp: false, whenCaughtUp: (signal?: AbortSignal) => new SyncSessionState().whenLeader(signal) }
    const { rewriter } = createRewriter(createDeps({ catchUp }))

    await expect(rewriter.request({ waitTimeoutMs: 10 })).rejects.toMatchObject({ stage: 'waitingForSync' })
  })

  it('stops a waiting request when cancelled', async () => {
    const { rewriter } = createRewriter(createDeps({ session: new SyncSessionState() }))

    const running = rewriter.request()
    await vi.waitFor(() => expect(rewriter.stage).toBe('waitingForLeader'))
    rewriter.cancel()

    await expect(running).rejects.toThrow('Re-encryption cancelled')
    expect(rewriter.stage).toBeNull()
  })

  it('lets a request start again after a cancelled one', async () => {
    const session = new SyncSessionState()
    const { rewriter } = createRewriter(createDeps({ session }))
    const first = rewriter.request()
    await vi.waitFor(() => expect(rewriter.stage).toBe('waitingForLeader'))
    rewriter.cancel()
    await expect(first).rejects.toThrow()

    session.setLeader(true)
    await expect(rewriter.request()).resolves.toEqual({ succeeded: [], failed: [] })
  })

  it('prepares by waiting as a request would, without rewriting anything', async () => {
    const { rewriter } = createRewriter(createDeps({ session: new SyncSessionState() }))

    await expect(rewriter.prepare({ waitTimeoutMs: 10 })).rejects.toMatchObject({ stage: 'waitingForLeader' })
    expect(mockListItemIds).not.toHaveBeenCalled()
    expect(rewriter.stage).toBeNull()

    await createRewriter(createDeps()).rewriter.prepare({ waitTimeoutMs: 10 })
  })
})

describe('SnapshotRewriter callers', () => {
  let rewriter: SnapshotRewriter

  beforeEach(() => {
    mockListItemIds.mockResolvedValue(['item-1', 'item-2'])
    ;({ rewriter } = createRewriter(createDeps()))
  })

  afterEach(() => {
    rewriter.cancel()
  })

  it('stops at once, quarantining nothing, when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('User cancelled'))

    await expect(rewriter.request({ signal: controller.signal })).rejects.toThrow('User cancelled')

    expect(mockPutSnapshots).not.toHaveBeenCalled()
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('restarts the pass over every item when a request comes during one, and both callers get its result', async () => {
    let releaseFirst!: () => void
    mockPutSnapshots
      .mockImplementationOnce(() => new Promise(resolve => {
        releaseFirst = () => resolve({ success: true })
      }))
      .mockResolvedValue({ success: true })
    const onProgress1 = vi.fn()
    const onProgress2 = vi.fn()

    const first = rewriter.request({ onProgress: onProgress1 })
    await vi.waitFor(() => expect(mockPutSnapshots).toHaveBeenCalledTimes(1))
    const second = rewriter.request({ onProgress: onProgress2 })
    await vi.waitFor(() => expect(mockListItemIds).toHaveBeenCalledTimes(2))
    releaseFirst()

    const [result1, result2] = await Promise.all([first, second])

    expect(result1).toEqual({ succeeded: ['item-1', 'item-2'], failed: [] })
    expect(result2).toBe(result1)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
    expect(onProgress1).toHaveBeenLastCalledWith(2, 2)
    expect(onProgress2).toHaveBeenLastCalledWith(2, 2)
  })

  it('lets a caller stop waiting without stopping the rewrite for the others', async () => {
    let releaseUpload!: () => void
    mockPutSnapshots.mockImplementation(() => new Promise(resolve => {
      releaseUpload = () => resolve({ success: true })
    }))
    const controller = new AbortController()

    const first = rewriter.request()
    const second = rewriter.request({ signal: controller.signal })
    await vi.waitFor(() => expect(mockPutSnapshots).toHaveBeenCalled())
    controller.abort(new Error('Caller 2 cancelled'))

    await expect(second).rejects.toThrow('Caller 2 cancelled')
    releaseUpload()
    expect(await first).toEqual({ succeeded: ['item-1', 'item-2'], failed: [] })
  })

  it('cancels a pass in flight, rejecting its callers without failing the poll', async () => {
    let releaseUpload!: () => void
    mockPutSnapshots.mockImplementation(() => new Promise(resolve => {
      releaseUpload = () => resolve({ success: true })
    }))
    const { rewriter: cancelling, outcomes } = createRewriter(createDeps())
    mockListItemIds.mockResolvedValue(Array.from({ length: 12 }, (_, i) => `item-${i}`))

    const running = cancelling.request()
    await vi.waitFor(() => expect(mockPutSnapshots).toHaveBeenCalledTimes(1))
    cancelling.cancel()
    releaseUpload()

    await expect(running).rejects.toThrow('Re-encryption cancelled')
    await vi.waitFor(() => expect(outcomes).toEqual(['success']))
    // The second chunk never went
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(cancelling.pendingCount).toBe(0)
    expect(cancelling.stage).toBeNull()
  })
})
