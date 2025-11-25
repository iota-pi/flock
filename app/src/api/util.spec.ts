const dispatch = vi.hoisted(() => vi.fn())
const getState = vi.hoisted(() => vi.fn(() => ({ account: { account: 'acct1' } })))

vi.mock('../store', () => ({ default: { dispatch, getState } }))

vi.mock('../state/ui', () => ({
  startRequest: () => ({ type: 'START' }),
  finishRequest: (err?: string) => ({ type: 'FINISH', error: err }),
}))

vi.mock('./axios', () => ({
  getAxios: (allowNoInit?: boolean) => ({ mockedAxios: true, allowNoInit }),
}))

import { getAccountId, flockRequest, flockRequestChunked } from './util'

beforeEach(() => {
  dispatch.mockClear()
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
    const result = await flockRequest(async axios => {
      // ensure axios passed through
      expect(axios).toHaveProperty('mockedAxios')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(dispatch).toHaveBeenCalled()
    // first call should be start, second finish
    expect(dispatch.mock.calls[0][0]).toEqual({ type: 'START' })
    expect(dispatch.mock.calls[1][0]).toEqual({ type: 'FINISH', error: undefined })
  })

  it('flockRequest throws and dispatches finish with error message on failure', async () => {
    await expect(flockRequest(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // check that finish was dispatched with our user-friendly message
    const lastCall = dispatch.mock.calls[dispatch.mock.calls.length - 1][0]
    expect(lastCall).toEqual({ type: 'FINISH', error: 'A request to the server failed. Please retry later.' })
  })

  it('flockRequestChunked splits requests and returns array of results', async () => {
    const data = Array.from({ length: 25 }, (_, i) => i)
    const requestFactory = () => async (batch: number[]) => {
      // return the batch length so we can assert correctness
      return batch.length
    }

    const results = await flockRequestChunked({ data, requestFactory, chunkSize: 10 })
    expect(results).toHaveLength(3)
    expect(results).toEqual([10, 10, 5])
    // start and finish dispatched
    const calls = dispatch.mock.calls
    expect(calls[calls.length - 2][0]).toEqual({ type: 'START' })
    expect(calls[calls.length - 1][0]).toEqual({ type: 'FINISH', error: undefined })
  })
})
