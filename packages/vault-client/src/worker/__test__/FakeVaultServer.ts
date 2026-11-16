import { TRPCClientError } from '@trpc/client'
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'
import type { VaultRouter } from '@vault/server'
import {
  FetchItemsInputSchema,
  FetchSnapshotsByIdsInputSchema,
  MAX_ITEM_SIZE_BYTES,
  PollLogSchema,
  PutSnapshotBatchSchema,
  QUOTA_EXCEEDED_MESSAGE,
  type FetchedItem,
  type ItemId,
  type ManifestEntry,
  type SyncLogEntry,
  type VaultSnapshotInput,
} from '@vault/shared'
import type { z } from 'zod'
import type { VaultServerBackend } from './vaultServers'

const PAGE_SIZE = 200

type Inputs = inferRouterInputs<VaultRouter>
type Outputs = inferRouterOutputs<VaultRouter>

interface ServerItem {
  version: number
  snapshot?: VaultSnapshotInput['snapshot']
  heads?: VaultSnapshotInput['heads']
  deleted: boolean
  modifiedAt: number
}

/** About how large the server stores a snapshot, with its ciphertext as binary */
function storedSize({ snapshot, heads }: VaultSnapshotInput): number {
  const cipherBytes = snapshot ? Math.floor(snapshot.cipher.length * 3 / 4) : 0
  return cipherBytes + JSON.stringify({ snapshot: { ...snapshot, cipher: undefined }, heads }).length
}

/** The errors the fake sends, with their JSON-RPC codes and HTTP statuses as tRPC gives them */
const SERVER_ERRORS = {
  BAD_REQUEST: { rpcCode: -32600, httpStatus: 400 },
  UNAUTHORIZED: { rpcCode: -32001, httpStatus: 401 },
  TOO_MANY_REQUESTS: { rpcCode: -32029, httpStatus: 429 },
} as const

/** An error as the vault's tRPC client reports one the server sent */
function serverError(code: keyof typeof SERVER_ERRORS, message: string): TRPCClientError<VaultRouter> {
  const { rpcCode, httpStatus } = SERVER_ERRORS[code]
  return TRPCClientError.from({ error: { code: rpcCode, message, data: { code, httpStatus } } })
}

/**
 * The vault server, as far as the sync engine can tell: a blind relay with one ordered log. It
 * answers as the server's procedures do (`FakeVaultServer.spec.ts` runs the same calls against both
 * to keep it so), but keeps one account and ignores which one a request names.
 */
export class FakeVaultServer implements VaultServerBackend {
  readonly session = 'session-token'
  rows: SyncLogEntry[] = []
  readonly items = new Map<ItemId, ServerItem>()
  /** Rows a read can't see yet, like the part of a transaction that isn't visible */
  readonly hiddenSeqs = new Set<number>()
  head = 0
  /** Set to make every request fail, as it does while the server can't be reached */
  isDown = false
  /** Set to reject the device's session, as the server does once it has ended */
  rejectsSessions = false
  /** Set to turn away pushes, as for an account that has appended its day's quota to the log */
  isOverLogQuota = false
  /** Set to turn away snapshots, as for an account that has used its storage quota */
  isOverStorageQuota = false
  clock = () => Date.now()

  private checkRequest(): void {
    if (this.isDown) throw TRPCClientError.from(new TypeError('Failed to fetch'))
    if (this.rejectsSessions) throw serverError('UNAUTHORIZED', 'UNAUTHORIZED')
  }

  private parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
    const result = schema.safeParse(input)
    if (!result.success) throw serverError('BAD_REQUEST', result.error.message)
    return result.data
  }

  pollLog(rawInput: Inputs['sync']['pollLog']): Outputs['sync']['pollLog'] {
    this.checkRequest()
    const input = this.parse(PollLogSchema, rawInput)
    if (input.push.length > 0 && this.isOverLogQuota) {
      throw serverError('TOO_MANY_REQUESTS', QUOTA_EXCEEDED_MESSAGE)
    }
    const pushResults = input.push.map(({ itemId, encryptedMessage }) => {
      this.head += 1
      this.rows.push({ seq: this.head, itemId, encryptedMessage, createdAt: this.clock() })
      return { itemId, seq: this.head }
    })
    const visible = this.rows.filter(row => row.seq > input.after && !this.hiddenSeqs.has(row.seq))
    return {
      pushResults,
      entries: visible.slice(0, PAGE_SIZE),
      hasMore: visible.length > PAGE_SIZE,
      serverNow: this.clock(),
    }
  }

  putSnapshots(rawInput: Inputs['items']['putSnapshots']): Outputs['items']['putSnapshots'] {
    this.checkRequest()
    const input = this.parse(PutSnapshotBatchSchema, rawInput)
    // The storage quota turns away a whole batch that carries any content, but never a deletion
    if (this.isOverStorageQuota && input.snapshots.some(snapshot => snapshot.snapshot)) {
      throw serverError('TOO_MANY_REQUESTS', QUOTA_EXCEEDED_MESSAGE)
    }
    // Each is written on its own, and one the server can't store is left out of the results
    const results = input.snapshots.filter(snapshot => storedSize(snapshot) <= MAX_ITEM_SIZE_BYTES)
      .map(snapshot => ({ itemId: snapshot.itemId, version: this.write(snapshot) }))
    const total = input.snapshots.length
    return { success: results.length === total, persisted: results.length, total, results, logSeq: this.head }
  }

  /** Writes an item as the server's driver does, returning the version it made (0 for none) */
  private write(snapshot: VaultSnapshotInput): number {
    const existing = this.items.get(snapshot.itemId)
    const version = (existing?.version ?? 0) + 1
    // The server's own clock: it never stores the client's `modified`
    const modifiedAt = this.clock()
    if (snapshot.deleted !== true && existing?.deleted !== true) {
      this.items.set(snapshot.itemId, {
        version,
        snapshot: snapshot.snapshot ?? existing?.snapshot,
        // Heads describe the snapshot written with them, so a write without them removes them
        heads: snapshot.snapshot ? snapshot.heads : undefined,
        deleted: false,
        modifiedAt,
      })
      return version
    }
    // Deletion is terminal, and a tombstone keeps nothing of the item's content. A payload-less
    // tombstone only marks an item the server has deleted.
    if (!existing && !snapshot.snapshot) return 0
    this.items.set(snapshot.itemId, { version, deleted: true, modifiedAt })
    return version
  }

  fetchManifest(rawInput: Inputs['items']['fetchManifest']): Outputs['items']['fetchManifest'] {
    this.checkRequest()
    this.parse(FetchItemsInputSchema, rawInput)
    const manifest: ManifestEntry[] = Array.from(this.items.entries()).map(([itemId, item]) => ({
      itemId,
      version: item.version,
      modifiedAt: item.modifiedAt,
      ...(item.deleted ? { isDeleted: true } : {}),
      ...(item.heads && !item.deleted ? { heads: item.heads } : {}),
    }))
    return { success: true, manifest, serverTime: this.clock() }
  }

  fetchSnapshotsByIds(rawInput: Inputs['items']['fetchSnapshotsByIds']): Outputs['items']['fetchSnapshotsByIds'] {
    this.checkRequest()
    const input = this.parse(FetchSnapshotsByIdsInputSchema, rawInput)
    const items = Array.from(new Set(input.itemIds)).flatMap((itemId): FetchedItem[] => {
      const item = this.items.get(itemId)
      if (!item) return []
      return [{
        item: itemId,
        version: item.version,
        metadata: { iv: '', ...(item.deleted ? { deleted: true } : {}) },
        ...(item.snapshot && !item.deleted ? { snapshot: item.snapshot } : {}),
      } as FetchedItem]
    })
    if (input.maxResponseChars === undefined) {
      return { success: true, items, serverTime: this.clock() }
    }
    // Items in the order asked for, until the next would pass the limit (always at least one)
    let chars = 0
    let count = 0
    for (const item of items) {
      chars += 'snapshot' in item && item.snapshot ? item.snapshot.cipher.length : 0
      if (count > 0 && chars > input.maxResponseChars) break
      count += 1
    }
    return {
      success: true,
      items: items.slice(0, count),
      deferred: items.slice(count).map(item => item.item),
      serverTime: this.clock(),
    }
  }

  /** Empties the log, as the TTL eventually does */
  expireLog(throughSeq = this.head): void {
    this.rows = this.rows.filter(row => row.seq > throughSeq)
  }

  loseRow(seq: number): void {
    this.rows = this.rows.filter(row => row.seq !== seq)
  }

  /** A stand-in for the vault's tRPC client, which sends each request to this server */
  get trpcClient(): VaultTrpcClient {
    // Looked up on each request, so that a spy a test puts on a method applies
    return {
      items: {
        fetchManifest: { query: async input => this.fetchManifest(input) },
        fetchSnapshotsByIds: { query: async input => this.fetchSnapshotsByIds(input) },
        putSnapshots: { mutate: async input => this.putSnapshots(input) },
      },
      sync: {
        pollLog: { mutate: async input => this.pollLog(input) },
      },
    }
  }
}

/** The procedures of the vault's tRPC client that the sync worker calls */
export interface VaultTrpcClient {
  items: {
    fetchManifest: { query: (input: Inputs['items']['fetchManifest']) => Promise<Outputs['items']['fetchManifest']> }
    fetchSnapshotsByIds: {
      query: (input: Inputs['items']['fetchSnapshotsByIds']) => Promise<Outputs['items']['fetchSnapshotsByIds']>
    }
    putSnapshots: { mutate: (input: Inputs['items']['putSnapshots']) => Promise<Outputs['items']['putSnapshots']> }
  }
  sync: {
    pollLog: { mutate: (input: Inputs['sync']['pollLog']) => Promise<Outputs['sync']['pollLog']> }
  }
}
