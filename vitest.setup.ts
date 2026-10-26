import { threadId } from 'node:worker_threads'

// Test files share each worker thread (`isolate: false`), and this file runs again before each
// one. Anything it sets up must therefore be idempotent, and anything a file can leave behind
// is reset here.

// Node delivers BroadcastChannel messages between the threads of one process. Scope each channel
// to its thread, so one worker's messages never reach another's. Wrap the original class only
// once, since this file runs for every test file.
const ORIGINAL_BROADCAST_CHANNEL = Symbol.for('vitest.originalBroadcastChannel')
const globals = globalThis as typeof globalThis & { [ORIGINAL_BROADCAST_CHANNEL]?: typeof BroadcastChannel }
const ProcessBroadcastChannel = globals[ORIGINAL_BROADCAST_CHANNEL] ?? globalThis.BroadcastChannel
globals[ORIGINAL_BROADCAST_CHANNEL] = ProcessBroadcastChannel

globalThis.BroadcastChannel = class ThreadBroadcastChannel extends ProcessBroadcastChannel {
  readonly #name: string

  constructor(name: string) {
    super(`${threadId}:${name}`)
    this.#name = name
  }

  override get name(): string {
    return this.#name
  }
} as typeof BroadcastChannel

// A file that leaves fake timers on would stall every later file in the worker
afterEach(() => {
  vi.useRealTimers()
})

// Restoring a spy that a test put on a fake timer (`vi.spyOn(globalThis, 'setTimeout')` under
// `vi.useFakeTimers()`) brings the fake back after `useRealTimers`, and Vitest restores spies
// before each test. So put the worker's real timers back before each test.
const REAL_TIMERS = Symbol.for('vitest.realTimers')
const TIMER_NAMES = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date',
] as const
type Timers = Pick<typeof globalThis, typeof TIMER_NAMES[number]>
const timerGlobals = globalThis as typeof globalThis & { [REAL_TIMERS]?: Timers }
const realTimers = timerGlobals[REAL_TIMERS] ??= Object.fromEntries(
  TIMER_NAMES.map(name => [name, globalThis[name]]),
) as unknown as Timers

beforeEach(() => {
  if (vi.isFakeTimers()) return
  for (const name of TIMER_NAMES) {
    if (globalThis[name] !== realTimers[name]) {
      Object.assign(globalThis, { [name]: realTimers[name] })
    }
  }
})
