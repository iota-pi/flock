export interface ParsedError {
  status?: number
  httpStatus?: number
  code?: string
  name?: string
  message?: string
  cause?: ParsedError
}

/**
 * Normalizes arbitrary unknown error values into a consistent ParsedError object.
 * Safely extracts HTTP status codes, error codes, error names, messages,
 * and recursively unwraps nested cause properties.
 */
export function parseError(error: unknown, seen = new WeakSet<object>()): ParsedError {
  if (!error) {
    return {}
  }

  if (typeof error !== 'object') {
    return {
      message: String(error),
    }
  }

  if (seen.has(error)) {
    return {}
  }
  seen.add(error)

  const anyError = error as { [key: string]: unknown }

  const name = typeof anyError.name === 'string' ? anyError.name : undefined
  const message = typeof anyError.message === 'string' ? anyError.message : undefined

  const data = (anyError.data || (anyError as { shape?: { data?: unknown } }).shape?.data) as
    | { [key: string]: unknown }
    | undefined

  const rawStatus =
    data?.httpStatus ??
    data?.status ??
    data?.statusCode ??
    anyError.httpStatus ??
    anyError.status ??
    anyError.statusCode

  let status: number | undefined
  if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) {
    status = rawStatus
  } else if (typeof rawStatus === 'string' && /^\d+$/.test(rawStatus)) {
    const parsed = parseInt(rawStatus, 10)
    if (!Number.isNaN(parsed)) {
      status = parsed
    }
  }

  const rawCode = data?.code ?? anyError.code
  const code = typeof rawCode === 'string' ? rawCode : undefined

  const cause = anyError.cause != null ? parseError(anyError.cause, seen) : undefined

  return {
    status,
    httpStatus: status,
    code,
    name,
    message,
    cause,
  }
}
