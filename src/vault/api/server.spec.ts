import * as Sentry from '@sentry/node'
import createServer from './index'

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

  it('suppresses expected UNAUTHORIZED client errors from Sentry', async () => {
    const server = await createServer(true)
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/trpc/items.putSnapshots',
        headers: { 'content-type': 'application/json' },
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
    const mockVault = (server as any).vault
    vi.spyOn(mockVault, 'getNewAccountId').mockRejectedValue(new Error('DynamoDB Connection Failure'))

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/trpc/accounts.createAccount',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          authToken: 'mock-token',
          salt: 'mock-salt',
          iterations: 1000,
          saltVersion: 1,
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
