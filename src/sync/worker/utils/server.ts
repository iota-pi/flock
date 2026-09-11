export function isServerError(error: unknown): boolean {
  if (!error) {
    return false
  }

  if (typeof error !== 'object') {
    return isServerErrorMessage(String(error).toLowerCase())
  }

  const anyError = error as { [key: string]: unknown }

  // Check error name
  const name = typeof anyError.name === 'string' ? anyError.name : ''
  if (name === 'InternalServerError' || name === 'ServerError') {
    return true
  }

  // Check HTTP status (from TRPC error data or response)
  const data = (anyError.data || (anyError as { shape?: { data?: unknown } }).shape?.data) as
    | { httpStatus?: number; code?: string }
    | undefined
  const httpStatus =
    data?.httpStatus ??
    (anyError.httpStatus as number | undefined) ??
    (anyError.status as number | undefined) ??
    (anyError.statusCode as number | undefined)

  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) {
    return true
  }

  // Check error code
  const code = (data?.code ?? anyError.code) as string | undefined
  if (code && typeof code === 'string') {
    const upperCode = code.toUpperCase()
    if (upperCode === 'INTERNAL_SERVER_ERROR' || upperCode === 'SERVER_ERROR') {
      return true
    }
  }

  // Check error message
  const message = typeof anyError.message === 'string' ? anyError.message.toLowerCase() : ''
  if (isServerErrorMessage(message)) {
    return true
  }

  // Check cause recursively
  if (anyError.cause) {
    return isServerError(anyError.cause)
  }

  return false
}

function isServerErrorMessage(message: string): boolean {
  if (!message) return false
  return (
    message.includes('internal server error') ||
    message.includes('server error') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout')
  )
}
