import { type Remote, wrap } from 'comlink'

type DecryptionWorkerApi = {
  mergeObjects: (input: {
    left: Record<string, unknown>
    right: Record<string, unknown>
  }) => Promise<Record<string, unknown>>
}

let decryptionWorker: Worker | null = null
let decryptionWorkerApi: Remote<DecryptionWorkerApi> | null = null

function getDecryptionWorkerApi(): Remote<DecryptionWorkerApi> {
  if (decryptionWorkerApi) {
    return decryptionWorkerApi
  }

  decryptionWorker = new Worker(new URL('./decryption.worker.ts', import.meta.url), {
    type: 'module',
  })
  decryptionWorkerApi = wrap<DecryptionWorkerApi>(decryptionWorker)

  decryptionWorker.onerror = event => {
    const error = new Error(event.message || 'Worker merge failed')
    console.error(error)
    decryptionWorker = null
    decryptionWorkerApi = null
  }

  return decryptionWorkerApi
}

export async function mergeObjectsInWorker<T extends Record<string, unknown>>(input: {
  left: T
  right: T
}): Promise<T> {
  const api = getDecryptionWorkerApi()
  const merged = await api.mergeObjects({
    left: input.left,
    right: input.right,
  })

  return merged as T
}
