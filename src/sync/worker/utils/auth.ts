import { classifySyncError } from './errorClassifier'

export function isAuthError(error: unknown): boolean {
  return classifySyncError(error).isAuth
}

