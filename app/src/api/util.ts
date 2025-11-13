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

export type FlockRequestOptions = {
  allowNoInit?: boolean,
}
export type FlockRequestFactory<T> = (axios: AxiosInstance) => Promise<T>
export async function flockRequest<T>(
  params: FlockRequestFactory<T> | {
    factory: FlockRequestFactory<T>,
    options?: FlockRequestOptions,
  },
): Promise<T> {
  const options = typeof params === 'function' ? {} : params.options || {}
  const factory = typeof params === 'function' ? params : params.factory

  startRequest()
  try {
    const promise = factory(getAxios(options.allowNoInit))
    const result = await promise
    finishRequest()
    return result
  } catch (error) {
    finishRequest('A request to the server failed. Please retry later.')
    throw error
  }
}

export async function flockRequestChunked<T, S>(
  {
    data,
    requestFactory,
    chunkSize = 10,
    options = {},
  }: {
    data: T[],
    requestFactory: (axios: AxiosInstance) => (data: T[]) => Promise<S>,
    chunkSize?: number,
    options?: FlockRequestOptions,
  },
): Promise<S[]> {
  startRequest()
  try {
    const workingData = data.slice()
    const result: S[] = []
    while (workingData.length > 0) {
      const batch = workingData.splice(0, chunkSize)
      const requestFunc = requestFactory(getAxios(options.allowNoInit))
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
