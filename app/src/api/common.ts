import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import {
  finishRequest as finishRequestAction,
  startRequest as startRequestAction,
} from '../state/ui'
import store from '../store'

let axiosWithAuth: AxiosInstance | null = null

export function initAxios(authToken: string) {
  axiosWithAuth = axios.create({
    ...getAuth(authToken),
  })
}

export function getAxios() {
  if (!axiosWithAuth) {
    throw new Error('Axios has not yet been initialised')
  }
  return axiosWithAuth
}

export function getAccountId() {
  const account = store.getState().account.account
  if (!account) {
    throw new Error('Account ID not set; cannot use API without account ID.')
  }
  return account
}

function getAuth(authToken: string): AxiosRequestConfig {
  return {
    headers: { Authorization: `Basic ${authToken}` },
  }
}

function startRequest() {
  store.dispatch(startRequestAction())
}

function finishRequest(error?: string) {
  store.dispatch(finishRequestAction(error))
}

export async function wrapRequest<T>(factory: (axios: AxiosInstance) => Promise<T>): Promise<T> {
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

export async function wrapManyRequests<T, S>(
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
