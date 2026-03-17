const startRequest = vi.hoisted(() => vi.fn())
const finishRequest = vi.hoisted(() => vi.fn())
const getState = vi.hoisted(() => vi.fn(() => ({ account: { account: 'acct1' } })))

vi.mock('../store', () => ({
  default: {
    actions: {
      startRequest,
      finishRequest,
    },
    getState,
  }
}))

vi.mock('./axios', () => ({
  getAxios: (allowNoInit?: boolean) => ({ mockedAxios: true, allowNoInit }),
}))

import type { AxiosResponse } from 'axios'
import { getAccountId, flockRequest, flockRequestChunked } from './util'

beforeEach(() => {
  startRequest.mockClear()
  finishRequest.mockClear()
  getState.mockImplementation(() => ({ account: { account: 'acct1' } }))
})

describe('api util', () => {
  it('getAccountId returns account when set', () => {
    expect(getAccountId()).toBe('acct1')
  })

  it('getAccountId throws when account not set', () => {
    getState.mockImplementation(() => ({ account: { account: '' } }))
    expect(() => getAccountId()).toThrow('Account ID not set')
  })

  it('flockRequest calls start and finish and returns result', async () => {
    const result = await flockRequest<string>(async axios => {
      // ensure axios passed through
      expect(axios).toHaveProperty('mockedAxios')
      return { data: 'ok' } as AxiosResponse<string>
    })
    expect(result).toBe('ok')
    expect(startRequest).toHaveBeenCalledTimes(1)
    expect(finishRequest).toHaveBeenCalledWith(undefined)
  })

  it('flockRequest throws and dispatches finish with error message on failure', async () => {
    await expect(flockRequest(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(startRequest).toHaveBeenCalledTimes(1)
    expect(finishRequest).toHaveBeenCalledWith('A request to the server failed. Please retry later.')
  })

  it('flockRequestChunked splits requests and returns array of results', async () => {
    const data = Array.from({ length: 25 }, (_, i) => i)
    const requestFactory = () => async (batch: number[]) => {
      // return the batch length so we can assert correctness
      return { data: batch.length } as AxiosResponse<number>
    }

    const results = await flockRequestChunked({ data, requestFactory, chunkSize: 10 })
    expect(results).toHaveLength(3)
    expect(results).toEqual([10, 10, 5])
    expect(startRequest).toHaveBeenCalledTimes(1)
    expect(finishRequest).toHaveBeenCalledWith(undefined)
  })
})
