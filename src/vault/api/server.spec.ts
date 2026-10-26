import * as Sentry from '@sentry/node'
import { CURRENT_SALT_VERSION, getDefaultKdf, PROTOCOL_VERSION_HEADER, VAULT_PROTOCOL_VERSION } from '@vault/shared'
import DynamoDriver from '@vault/server/dynamo'
import createServer, { getUnknownAccountParams } from './index'
import { FLOCK_DATA_VERSION } from '../../shared/flockDataVersion'

const CURRENT_PROTOCOL = { [PROTOCOL_VERSION_HEADER]: String(VAULT_PROTOCOL_VERSION) }

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((fn: (scope: any) => void) => {
    const scope = {
      setTag: vi.fn(),
      setUser: vi.fn(),
    }
    fn(scope)
  }),
}))

describe('createServer error reporting', () => {
  const originalEnv = process.env.SENTRY_DSN

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(Sentry.captureException).mockClear()
    process.env.SENTRY_DSN = 'https://fake@sentry.io/123'
  })

  afterEach(() => {
    process.env.SENTRY_DSN = originalEnv
    vi.restoreAllMocks()
  })

  it('turns away writes from builds below the minimum protocol version', async () => {
    const server = await createServer(true)
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/trpc/items.putSnapshots',
        headers: { 'content-type': 'application/json', [PROTOCOL_VERSION_HEADER]: '0' },
        payload: { account: 'test-account', snapshots: [] },
      })

      expect(response.statusCode).toBe(412)
      expect(response.json().error.message).toBe('CLIENT_OUTDATED')
    } finally {
      await server.close()
    }
  })

  it('suppresses expected UNAUTHORIZED client errors from Sentry', async () => {
    const server = await createServer(true)
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/trpc/items.putSnapshots',
        headers: { 'content-type': 'application/json', ...CURRENT_PROTOCOL },
        payload: { account: 'test-account', snapshots: [] },
      })

      expect(response.statusCode).toBe(401)
      expect(Sentry.captureException).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('captures unexpected internal errors in Sentry with tRPC path tag', async () => {
    const server = await createServer(true)
    vi.spyOn(DynamoDriver.prototype, 'getNewAccountId').mockRejectedValue(new Error('DynamoDB Connection Failure'))

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/trpc/accounts.createAccount',
        headers: {
          'content-type': 'application/json',
          ...CURRENT_PROTOCOL,
        },
        payload: {
          authToken: 'mock-token',
          salt: 'mock-salt',
          saltVersion: 1,
          kdf: { algorithm: 'argon2id', memoryKiB: 65536, passes: 3, parallelism: 1 },
          keyring: 'mock-keyring',
          randomDataKeys: true,
        },
      })

      expect(response.statusCode).toBe(500)
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'DynamoDB Connection Failure' })
      )
    } finally {
      await server.close()
    }
  })
})

describe('createServer unknown accounts', () => {
  it('answers an unknown account with stable parameters shaped like a new account\'s', async () => {
    const server = await createServer(true)
    try {
      const input = encodeURIComponent(JSON.stringify({ account: `unknown-${crypto.randomUUID()}` }))
      const request = () => server.inject({ method: 'GET', url: `/trpc/accounts.getSecurityParams?input=${input}` })

      const first = await request()
      expect(first.statusCode).toBe(200)
      const params = first.json().result.data
      expect(params).toMatchObject({ saltVersion: CURRENT_SALT_VERSION, kdf: getDefaultKdf(), dataVersion: FLOCK_DATA_VERSION })
      expect(Buffer.from(params.salt, 'base64')).toHaveLength(16)
      expect((await request()).json().result.data).toEqual(params)
    } finally {
      await server.close()
    }
  })
})

describe('getUnknownAccountParams', () => {
  const originalSecret = process.env.UNKNOWN_ACCOUNT_SECRET

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.UNKNOWN_ACCOUNT_SECRET
    } else {
      process.env.UNKNOWN_ACCOUNT_SECRET = originalSecret
    }
    vi.restoreAllMocks()
  })

  it('uses the configured secret, and a fixed one only for a local server', () => {
    process.env.UNKNOWN_ACCOUNT_SECRET = 'configured'
    expect(getUnknownAccountParams(false)).toMatchObject({ secret: 'configured' })

    delete process.env.UNKNOWN_ACCOUNT_SECRET
    expect(getUnknownAccountParams(true)?.secret).toBeTypeOf('string')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(getUnknownAccountParams(false)).toBeUndefined()
  })
})
