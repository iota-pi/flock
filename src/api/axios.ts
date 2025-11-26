import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  CreateAxiosDefaults,
} from 'axios'
import env from '../env'

let axiosWithAuth: AxiosInstance | null = null

const baseOptions: CreateAxiosDefaults = {
  baseURL: env.VAULT_ENDPOINT,
}

export function initAxios(authToken: string) {
  axiosWithAuth = axios.create({
    ...baseOptions,
    ...getAuth(authToken),
  })
}

export function getAxios(allowNoInit = false): AxiosInstance {
  if (!axiosWithAuth) {
    if (allowNoInit) {
      return axios.create(baseOptions)
    }
    throw new Error('Axios has not yet been initialised')
  }
  return axiosWithAuth
}

function getAuth(authToken: string): AxiosRequestConfig {
  return {
    headers: { Authorization: `Basic ${authToken}` },
  }
}
