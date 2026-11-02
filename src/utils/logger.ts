/**
 * Flock's logging. Each module creates a logger tagged with its name, so every message says where
 * it came from. The vault packages log through their own logger; this one is for Flock's code.
 */
export interface Logger {
  readonly tag: string
  /** Only printed in development builds */
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`

  return {
    tag,
    debug: (...args) => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug(prefix, ...args)
      }
    },
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  }
}
