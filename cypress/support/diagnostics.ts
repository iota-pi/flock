/**
 * Records what the app logs and each API request it makes, and prints them to the terminal when a
 * test fails. CI shows only Cypress's own output, so an error the app logs and recovers from (such
 * as a login request that never reached the server, reported to the user as a wrong password)
 * otherwise leaves no trace.
 */

const MAX_ENTRIES = 400
const CONSOLE_METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const

let entries: string[] = []
let testStart = Date.now()

function record(line: string) {
  const elapsed = ((Date.now() - testStart) / 1000).toFixed(2)
  entries.push(`+${elapsed}s ${line}`)
  if (entries.length > MAX_ENTRIES) {
    entries.shift()
  }
}

/** Describes a logged value. Errors from the app's window aren't `instanceof Error` here, so they're duck-typed. */
function formatValue(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'message' in value && 'name' in value) {
    const { name, message, cause } = value as { name: unknown, message: unknown, cause?: unknown }
    const described = `${String(name)}: ${String(message)}`
    return cause !== undefined && depth < 3
      ? `${described} (cause: ${formatValue(cause, depth + 1)})`
      : described
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if ('href' in input) return input.href
  return input.url
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method
  if (typeof input === 'object' && 'method' in input) return input.method
  return 'GET'
}

Cypress.on('window:before:load', win => {
  record(`page load ${win.location.pathname}`)

  CONSOLE_METHODS.forEach(method => {
    const original = win.console[method]
    win.console[method] = (...args: unknown[]) => {
      record(`console.${method} ${args.map(arg => formatValue(arg)).join(' ')}`)
      original.apply(win.console, args)
    }
  })

  // The tRPC clients call the global fetch, so this sees every API request the page makes. A request
  // that's still pending when the test fails shows a start with no end.
  const originalFetch = win.fetch
  win.fetch = async (input, init) => {
    const url = getRequestUrl(input)
    const match = url.match(/\/trpc\/([^?]+)/)
    if (!match) {
      return originalFetch.call(win, input, init)
    }
    const name = `${getRequestMethod(input, init)} ${match[1]}`
    const start = Date.now()
    record(`fetch start ${name}`)
    try {
      const response = await originalFetch.call(win, input, init)
      record(`fetch end ${name}: ${response.status} after ${Date.now() - start}ms`)
      return response
    } catch (error) {
      record(`fetch failed ${name} after ${Date.now() - start}ms: ${formatValue(error)}`)
      throw error
    }
  }
})

beforeEach(() => {
  entries = []
  testStart = Date.now()
})

afterEach(function () {
  if (this.currentTest?.state !== 'failed') {
    return
  }
  const title = this.currentTest.fullTitle()
  const lines = entries
  entries = []
  cy.task('log', `Browser log for "${title}" (${lines.length} entries):\n${lines.join('\n')}`, { log: false })
})
