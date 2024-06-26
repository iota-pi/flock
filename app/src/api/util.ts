import type { AxiosInstance } from 'axios'
import {
  finishRequest as finishRequestAction,
  startRequest as startRequestAction,
} from '../state/ui'
import store from '../store'
import { getAxios } from './axios'

export function getAccountId() {
  const account = store.getState().account.account
  if (!account) {
    throw new Error('Account ID not set; cannot use API without account ID.')
  }
  return account
}

function startRequest() {
  store.dispatch(startRequestAction())
}

function finishRequest(error?: string) {
  store.dispatch(finishRequestAction(error))
}

export async function flockRequest<T>(factory: (axios: AxiosInstance) => Promise<T>): Promise<T> {
  startRequest()
  try {
    const promise = factory(getAxios())
    const result = await promise
    finishRequest()
    return result
  } catch (error) {
    finishRequest('A request to the server failed. Please retry later.')
    throw error
  }
}

export async function flockRequestChunked<T, S>(
  data: T[],
  requestFactory: (axios: AxiosInstance) => (data: T[]) => Promise<S>,
  chunkSize = 10,
): Promise<S[]> {
  startRequest()
  try {
    const workingData = data.slice()
    const result: S[] = []
    while (workingData.length > 0) {
      const batch = workingData.splice(0, chunkSize)
      // eslint-disable-next-line no-await-in-loop
      const requestFunc = requestFactory(getAxios())
      const batchResult = await requestFunc(batch)
      result.push(batchResult)
    }
    finishRequest()
    return result
  } catch (error) {
    finishRequest('A request to the server failed. Please retry later.')
    throw error
  }
}
