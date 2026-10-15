import type { ItemId } from 'src/shared/vault/ids'
import type { StoredSyncMessage } from 'src/vault/drivers/base'
import { syncRouter } from 'src/vault/trpc/routers/sync'
import { SyncPoller } from './SyncPoller'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { CursorStore } from './stores/CursorStore'
import { createMockKeyProvider, createTestEventHubs } from './__test__/testUtils'
import type { SyncApiClient } from './SyncApiClient'
import type { AutomergeIndexManager } from './docStore'

const keys = createMockKeyProvider()

const ACCOUNT = 'account-pagination'
const GLOBAL_PAGE_SIZE = 3

type StoredRow = StoredSyncMessage & { syncId: string }

/**
 * In-memory stand-in for the DynamoDB sync message table, paging the account-wide index
 * in small pages so global pagination is exercised.
 */
function createInMemoryVault(rows: StoredRow[]) {
  const byCursor = (a: StoredRow, b: StoredRow) => a.cursor - b.cursor || a.syncId.localeCompare(b.syncId)
  const toMessage = ({ cursor, encryptedMessage, createdAt }: StoredRow): StoredSyncMessage => ({
    cursor,
    encryptedMessage,
    createdAt,
  })

  // Page tokens are opaque to the client and router; this vault encodes its scan position as JSON
  const decode = (token?: string) => (token ? JSON.parse(token) as { cursor: number; syncId: string } : undefined)

  return {
    extendSession: vi.fn(async () => undefined),
    getAccount: vi.fn(async ({ account, session }: { account: string; session: string }) => ({
      account,
      sessions: [{ token: session, expires: Date.now() + 60_000 }],
    })),
    pushSyncMessagesBatch: vi.fn(async () => undefined),
    validatePageToken: vi.fn(),
    getSyncMessages: vi.fn(async (input: {
      itemId: ItemId
      fromCursor?: number
      pageToken?: string
    }) => {
      const syncId = `${ACCOUNT}#${input.itemId}`
      const after = decode(input.pageToken)?.cursor ?? input.fromCursor ?? -1
      const messages = rows.filter(r => r.syncId === syncId && r.cursor > after).sort(byCursor)
      return { messages: messages.map(toMessage), hasMore: false }
    }),
    getGlobalSyncMessagesAfterCursor: vi.fn(async (input: {
      cursor?: number
      pageToken?: string
    }) => {
      const start = decode(input.pageToken)
      const sorted = [...rows].sort(byCursor)
      const remaining = start
        ? sorted.filter(r => r.cursor > start.cursor || (r.cursor === start.cursor && r.syncId > start.syncId))
        : sorted.filter(r => r.cursor > (input.cursor ?? 0))
      const page = remaining.slice(0, GLOBAL_PAGE_SIZE)
      const hasMore = remaining.length > GLOBAL_PAGE_SIZE
      const last = page[page.length - 1]

      const items = new Map<ItemId, StoredSyncMessage[]>()
      for (const row of page) {
        const itemId = row.syncId.split('#')[1] as ItemId
        items.set(itemId, [...(items.get(itemId) ?? []), toMessage(row)])
      }
      return {
        items: Array.from(items, ([itemId, messages]) => ({ itemId, messages })),
        hasMore,
        nextPageToken: hasMore ? JSON.stringify({ cursor: last.cursor, syncId: last.syncId }) : undefined,
        scannedThroughCursor: last?.cursor ?? start?.cursor ?? input.cursor ?? 0,
      }
    }),
  }
}

function row(itemId: string, cursor: number): StoredRow {
  return {
    syncId: `${ACCOUNT}#${itemId}`,
    cursor,
    encryptedMessage: { iv: 'iv', cipher: `${itemId}@${cursor}` },
    createdAt: cursor,
  }
}

describe('global pull pagination (client ↔ router)', () => {
  it('delivers every message exactly once while a per-item pull runs ahead of the global scan', async () => {
    // item-x has a long backlog that needs several global pages; item-z is pulled per-item
    // and its newest message is far ahead of the global scan position.
    const rows = [10, 20, 30, 40, 50, 60, 70].map(c => row('item-x', c)).concat(row('item-z', 1000))
    const vault = createInMemoryVault(rows)
    const caller = syncRouter.createCaller({ authToken: 'session-token', vault } as never)

    const { clientEventHub, internalEventHub } = createTestEventHubs()
    const pullQueueManager = new SyncPullQueueManager(new CursorStore(ACCOUNT), keys, undefined, internalEventHub)
    await pullQueueManager.setAccount(ACCOUNT)
    pullQueueManager.addPendingItem('item-z' as ItemId)

    const delivered: string[] = []
    internalEventHub.subscribe(event => {
      if (event.type === 'messageParsed') {
        delivered.push(String(event.message))
      }
    })

    const apiClient = {
      pollSyncBatch: (input: Parameters<typeof caller.pollSync>[0]) => caller.pollSync(input),
    } as unknown as SyncApiClient
    const indexManager = { updateLastSyncTime: vi.fn() } as unknown as AutomergeIndexManager
    const poller = new SyncPoller(pullQueueManager, clientEventHub, internalEventHub, keys, indexManager, null, apiClient)
    poller.setAccount(ACCOUNT)

    const outcomes: string[] = []
    for (let i = 0; i < 10 && (i === 0 || pullQueueManager.hasImmediatePendingPulls()); i += 1) {
      outcomes.push(await poller.executePoll())
    }

    expect(outcomes.every(outcome => outcome === 'success')).toBe(true)
    expect(pullQueueManager.hasImmediatePendingPulls()).toBe(false)
    expect([...delivered].sort()).toEqual(rows.map(r => r.encryptedMessage.cipher).sort())
    expect(pullQueueManager.getGlobalScanCursor()).toBe(1000)
  })
})
