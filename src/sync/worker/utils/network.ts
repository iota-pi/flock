import { classifySyncError } from './errorClassifier'

export function isNetworkError(error: unknown): boolean {
  return classifySyncError(error).isNetwork
}

