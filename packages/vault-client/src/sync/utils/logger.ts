export interface Logger {
  readonly tag: string
  readonly prefix: string
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
}

export type LogTag = string | { name: string }

function formatArgs(prefix: string, args: unknown[]): unknown[] {
  if (!prefix) return args
  if (args.length === 0) return [prefix]

  const [first, ...rest] = args
  if (typeof first === 'string') {
    if (first.startsWith(prefix)) {
      return [first, ...rest]
    }
    return [`${prefix} ${first}`, ...rest]
  }
  return [prefix, ...args]
}

/**
 * Creates a tagged logger instance that prefixes all log messages with `[ClassName]` or `[tag]`.
 *
 * @param tagOrClass The class constructor or tag string (e.g. `'SyncEventProcessor'`).
 * @returns A Logger object with `error`, `warn`, `info`, `debug`, and `log` methods.
 *
 * @example
 * const log = createLogger('SyncEventProcessor')
 * log.error('Mutation failed:', event.mutationType)
 * // Output: [SyncEventProcessor] Mutation failed: ...
 */
export function createLogger(tagOrClass: LogTag): Logger {
  const rawTag =
    typeof tagOrClass === 'string'
      ? tagOrClass
      : (tagOrClass as { name?: string })?.name || ''
  const cleanTag = rawTag.trim().replace(/^\[+|\]+$/g, '')
  const prefix = cleanTag ? `[${cleanTag}]` : ''

  return {
    tag: cleanTag,
    prefix,
    error: (...args: unknown[]) => console.error(...formatArgs(prefix, args)),
    warn: (...args: unknown[]) => console.warn(...formatArgs(prefix, args)),
    info: (...args: unknown[]) => console.info(...formatArgs(prefix, args)),
    // eslint-disable-next-line no-console
    debug: (...args: unknown[]) => console.debug(...formatArgs(prefix, args)),
    // eslint-disable-next-line no-console
    log: (...args: unknown[]) => console.log(...formatArgs(prefix, args)),
  }
}
