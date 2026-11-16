import { createTRPCProxyClient } from '@trpc/client'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { createVaultContext, DEFAULT_ACCOUNT_QUOTAS, vaultRouter, type AccountQuotas, type VaultRouter } from '@vault/server'
import DynamoDriver from '@vault/server/dynamo'
import * as runtime from '../../keys/runtime'
import * as vaultTrpcClient from '../../keys/vaultTrpcClient'
import { SyncApiClient } from '../SyncApiClient'
import type { VaultTrpcClient } from './FakeVaultServer'

const DAY = 24 * 60 * 60 * 1000

/** The tables `vitest.dynamodb.ts` creates in the test DynamoDB Local */
const TEST_TABLES = {
  accounts: 'FlockAccounts',
  items: 'FlockItems',
  syncLog: 'FlockSyncLog',
  loginThrottle: 'FlockLoginThrottle',
}

/** A server the sync worker's requests can go to */
export interface VaultServerBackend {
  readonly trpcClient: VaultTrpcClient
  /** The session token the server accepts */
  readonly session: string
}

/**
 * Sends the realm's vault requests (which `SyncApiClient` makes) to `server`, with its session. A
 * test talks to one server, since these spies replace the realm's clients.
 */
export function routeVaultRequests(server: VaultServerBackend): void {
  const client = () => server.trpcClient as unknown as ReturnType<typeof vaultTrpcClient.getVaultTrpcClient>
  vi.spyOn(vaultTrpcClient, 'getVaultTrpcClient').mockImplementation(client)
  vi.spyOn(vaultTrpcClient, 'getUntrackedVaultTrpcClient').mockImplementation(client)
  vi.spyOn(runtime, 'getApiAuthToken').mockImplementation(() => server.session)
}

/** The sync worker's API client, as the worker builds it, sending requests to `server` */
export function createSyncApiClient(server: VaultServerBackend): SyncApiClient {
  routeVaultRequests(server)
  const apiClient = new SyncApiClient()
  // Goes through the accounts router, which sync tests don't exercise
  vi.spyOn(apiClient, 'raiseDataVersion').mockResolvedValue({ dataVersion: 0, blockers: [] })
  return apiClient
}

function randomId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/**
 * The vault's real server: its tRPC procedures, reached through the same links the app sends
 * requests with, on the test DynamoDB Local. Each one has its own account, with one session.
 */
export class RealVaultServer implements VaultServerBackend {
  readonly driver = new DynamoDriver({ tables: TEST_TABLES }).connect()
  readonly account = `contract${randomId().slice(0, 16)}`
  readonly session = randomId()
  /** Set to make every request fail, as it does while the server can't be reached */
  isDown = false
  private quotas: AccountQuotas = { ...DEFAULT_ACCOUNT_QUOTAS }

  async start(): Promise<this> {
    await this.driver.createAccount({ account: this.account, authToken: randomId(), salt: randomId(), iterations: 1 })
    await this.startSession()
    return this
  }

  async startSession(): Promise<void> {
    await this.driver.addSession({ account: this.account, session: this.session, expiry: Date.now() + DAY })
  }

  /** Ends the session, as logging out on another device or changing the password does */
  async endSession(): Promise<void> {
    await this.driver.removeSession({ account: this.account, session: this.session })
  }

  /** Puts the account over its log quota, or back under it */
  set isOverLogQuota(isOver: boolean) {
    this.quotas = { ...this.quotas, logBytesPerDay: isOver ? 0 : DEFAULT_ACCOUNT_QUOTAS.logBytesPerDay }
  }

  /** Puts the account over its storage quota, or back under it */
  set isOverStorageQuota(isOver: boolean) {
    this.quotas = { ...this.quotas, storageBytes: isOver ? 0 : DEFAULT_ACCOUNT_QUOTAS.storageBytes }
  }

  async stop(): Promise<void> {
    this.driver.client.destroy()
  }

  get trpcClient(): VaultTrpcClient {
    return createTRPCProxyClient<VaultRouter>({
      links: vaultTrpcClient.createVaultLinks({ url: 'http://vault.test/trpc', customFetch: this.fetch }),
    })
  }

  private readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.isDown) throw new TypeError('Failed to fetch')
    const req = new Request(input, init)
    // Named in lower case, as Node gives them to the server (happy-dom keeps their case)
    const headers = Object.fromEntries(Array.from(req.headers.entries(), ([name, value]) => [name.toLowerCase(), value]))
    return fetchRequestHandler({
      endpoint: '/trpc',
      req,
      router: vaultRouter,
      // As the app's server does, since the client sends queries as POSTs
      allowMethodOverride: true,
      createContext: () => createVaultContext({ vault: this.driver, quotas: this.quotas })(
        { req: { headers, ip: '127.0.0.1' } } as unknown as Parameters<ReturnType<typeof createVaultContext>>[0],
      ),
    })
  }
}
