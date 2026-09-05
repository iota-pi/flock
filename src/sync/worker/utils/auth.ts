export function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const anyError = error as { [key: string]: unknown }
  const data = (anyError.data || (anyError as { shape?: { data?: unknown } }).shape?.data) as
    | { httpStatus?: number; code?: string }
    | undefined
  const httpStatus =
    data?.httpStatus ??
    (anyError.httpStatus as number | undefined) ??
    (anyError.status as number | undefined) ??
    (anyError.statusCode as number | undefined)
  if (httpStatus === 401 || httpStatus === 403) {
    return true
  }

  const code = data?.code ?? (anyError.code as string | undefined)
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return true
  }

  if (anyError.cause && typeof anyError.cause === 'object') {
    const cause = anyError.cause as { [key: string]: unknown }
    const causeStatus = (cause.status ?? cause.statusCode ?? cause.httpStatus) as number | undefined
    if (causeStatus === 401 || causeStatus === 403) {
      return true
    }
    const causeCode = cause.code as string | undefined
    if (causeCode === 'UNAUTHORIZED' || causeCode === 'FORBIDDEN') {
      return true
    }
  }

  const name = anyError.name as string | undefined
  if (name === 'UnauthorizedError' || name === 'ForbiddenError') {
    return true
  }

  return false
}
