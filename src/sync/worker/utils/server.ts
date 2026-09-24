import { classifySyncError } from './errorClassifier'

export function isServerError(error: unknown): boolean {
  return classifySyncError(error).isServerError
}

