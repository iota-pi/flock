import { isPageInPlaceOfFile } from './builtAssets'

function respond(contentType: string): Response {
  return new Response('', { headers: { 'Content-Type': contentType } })
}

describe('isPageInPlaceOfFile', () => {
  it('flags HTML served for a script', () => {
    expect(isPageInPlaceOfFile('https://flock.example/assets/kdf.worker-abc.js', respond('text/html'))).toBe(true)
    expect(isPageInPlaceOfFile('/assets/index-abc.js', respond('text/html; charset=utf-8'))).toBe(true)
  })

  it('flags HTML served for other files', () => {
    expect(isPageInPlaceOfFile('/manifest.webmanifest', respond('text/html'))).toBe(true)
    expect(isPageInPlaceOfFile('/assets/automerge-abc.wasm', respond('text/html'))).toBe(true)
  })

  it('accepts the real file', () => {
    expect(isPageInPlaceOfFile('/assets/index-abc.js', respond('text/javascript'))).toBe(false)
    expect(isPageInPlaceOfFile('/assets/index-abc.css', respond('text/css'))).toBe(false)
  })

  it('accepts HTML pages and routes', () => {
    expect(isPageInPlaceOfFile('/index.html', respond('text/html'))).toBe(false)
    expect(isPageInPlaceOfFile('/migrate/index.html?__WB_REVISION__=abc', respond('text/html'))).toBe(false)
    expect(isPageInPlaceOfFile('/people', respond('text/html'))).toBe(false)
    expect(isPageInPlaceOfFile('/', respond('text/html'))).toBe(false)
  })
})
