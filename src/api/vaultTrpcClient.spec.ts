import { createTRPCProxyClient } from '@trpc/client'
import type { VaultRouter } from '../vault/trpc/vaultRouter'
import { configureVaultStorageNames, createVaultStorageNames } from '../sync/shared/storageNames'
import { PROTOCOL_VERSION_HEADER, VAULT_PROTOCOL_VERSION } from '../shared/vault/protocol'
import { createVaultLinks } from './vaultTrpcClient'

function trpcErrorResponse(message: string, code: string, httpStatus: number) {
  return new Response(
    JSON.stringify([{ error: { message, code: -32000, data: { code, httpStatus } } }]),
    { status: httpStatus, headers: { 'content-type': 'application/json' } },
  )
}

describe('createVaultLinks', () => {
  const postMessage = vi.fn()

  beforeEach(() => {
    configureVaultStorageNames(createVaultStorageNames('test'))
    postMessage.mockReset()
    vi.stubGlobal('BroadcastChannel', class {
      postMessage = postMessage
      close() {}
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function createClient(customFetch: typeof fetch) {
    return createTRPCProxyClient<VaultRouter>({
      links: createVaultLinks({ url: 'http://vault.test/trpc', customFetch }),
    })
  }

  it("sends this build's protocol version", async () => {
    const customFetch = vi.fn<typeof fetch>(async () => trpcErrorResponse('Unauthorized', 'UNAUTHORIZED', 401))

    await expect(createClient(customFetch).accounts.raiseDataVersion.mutate({ account: 'acct' })).rejects.toThrow()

    const headers = new Headers(customFetch.mock.calls[0][1]?.headers)
    expect(headers.get(PROTOCOL_VERSION_HEADER)).toBe(String(VAULT_PROTOCOL_VERSION))
  })

  it('announces when the server says this build is too old', async () => {
    const customFetch = vi.fn<typeof fetch>(async () => trpcErrorResponse('CLIENT_OUTDATED', 'PRECONDITION_FAILED', 412))

    await expect(createClient(customFetch).accounts.raiseDataVersion.mutate({ account: 'acct' })).rejects.toThrow()

    expect(postMessage).toHaveBeenCalledWith({ type: 'CLIENT_OUTDATED' })
  })

  it('does not announce other errors', async () => {
    const customFetch = vi.fn<typeof fetch>(async () => trpcErrorResponse('Unauthorized', 'UNAUTHORIZED', 401))

    await expect(createClient(customFetch).accounts.raiseDataVersion.mutate({ account: 'acct' })).rejects.toThrow()

    expect(postMessage).not.toHaveBeenCalled()
  })
})
