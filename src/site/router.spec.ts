import { handleSiteRequest, type SiteEnv } from './router'

function assetsServing(response: Response): SiteEnv {
  return { ASSETS: { fetch: vi.fn(async () => response) } }
}

describe('handleSiteRequest', () => {
  it('answers a missing script with an uncached 404 instead of the app shell', async () => {
    const shell = new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=31536000, immutable' },
    })
    const response = await handleSiteRequest(
      new Request('https://flock.example/assets/kdf.worker-abc.js'),
      assetsServing(shell),
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Type')).not.toContain('text/html')
  })

  it('passes through what the assets binding serves otherwise', async () => {
    const script = new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } })
    const shell = new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })

    expect(await handleSiteRequest(new Request('https://flock.example/assets/a.js'), assetsServing(script)))
      .toBe(script)
    expect(await handleSiteRequest(new Request('https://flock.example/people'), assetsServing(shell)))
      .toBe(shell)
  })
})
