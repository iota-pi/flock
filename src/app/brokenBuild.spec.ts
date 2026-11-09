import { isChunkLoadError, purgePagesCachedAsFiles } from './brokenBuild'

function fakeCache(entries: Record<string, Response>) {
  const store = new Map(Object.entries(entries))
  return {
    store,
    keys: vi.fn(async () => [...store.keys()].map(url => new Request(url))),
    match: vi.fn(async (request: Request) => store.get(request.url)),
    delete: vi.fn(async (request: Request) => store.delete(request.url)),
  }
}

function respond(contentType: string): Response {
  return new Response('', { headers: { 'Content-Type': contentType } })
}

describe('isChunkLoadError', () => {
  it('recognises failed script loads', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js')))
      .toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Loading chunk 12 failed'))).toBe(true)
  })

  it('ignores other errors', () => {
    expect(isChunkLoadError(new Error('Incorrect account ID or password'))).toBe(false)
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('purgePagesCachedAsFiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes cached pages stored under file names, and nothing else', async () => {
    const precache = fakeCache({
      'https://flock.example/assets/kdf.worker-abc.js': respond('text/html'),
      'https://flock.example/assets/main-abc.js': respond('text/javascript'),
      'https://flock.example/index.html?__WB_REVISION__=abc': respond('text/html'),
    })
    const lazy = fakeCache({
      'https://flock.example/assets/zxcvbn-abc.js': respond('text/html; charset=utf-8'),
    })
    const caches = { precache, lazy }
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => Object.keys(caches)),
      open: vi.fn(async (name: keyof typeof caches) => caches[name]),
    })

    expect(await purgePagesCachedAsFiles()).toBe(2)
    expect([...precache.store.keys()]).toEqual([
      'https://flock.example/assets/main-abc.js',
      'https://flock.example/index.html?__WB_REVISION__=abc',
    ])
    expect(lazy.store.size).toBe(0)
  })
})
