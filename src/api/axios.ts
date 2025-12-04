import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  CreateAxiosDefaults,
} from 'axios'
import env from '../env'

let axiosWithAuth: AxiosInstance | null = null
let onSessionExpired: (() => void) | null = null

const baseOptions: CreateAxiosDefaults = {
  baseURL: env.VAULT_ENDPOINT,
}

/**
 * Register a callback to be called when the session expires (403 response).
 * This is used to sign out the user and redirect to the login page.
 */
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler
}

export function initAxios(authToken: string) {
  axiosWithAuth = axios.create({
    ...baseOptions,
    ...getAuth(authToken),
  })

  // Add response interceptor to handle session expiry
  axiosWithAuth.interceptors.response.use(
    response => response,
    error => {
      if (error.response?.status === 403 && onSessionExpired) {
        onSessionExpired()
      }
      return Promise.reject(error)
    },
  )
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
