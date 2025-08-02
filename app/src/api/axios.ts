import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'

let axiosWithAuth: AxiosInstance | null = null

export function initAxios(authToken: string) {
  axiosWithAuth = axios.create({
    ...getAuth(authToken),
  })
}

export function getAxios(allowNoInit = false): AxiosInstance {
  if (!axiosWithAuth) {
    if (allowNoInit) {
      return axios.create()
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
