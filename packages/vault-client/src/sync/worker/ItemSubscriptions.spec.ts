import type { DocHandle, Repo } from '@automerge/automerge-repo/slim'
import type { ItemId } from '@vault/shared'
import type { RepoDoc } from './docStore'
import { ItemSubscriptions } from './ItemSubscriptions'

vi.mock('./utils/automerge', () => ({
  toAutomergeUrlFromItemId: (id: string) => `automerge:${id}`,
}))

function createHandle(documentId: string) {
  const listeners = new Set<() => void>()
  return {
    documentId,
    on: vi.fn((_event: string, fn: () => void) => listeners.add(fn)),
    off: vi.fn((_event: string, fn: () => void) => listeners.delete(fn)),
    doc: vi.fn(() => ({})),
    listeners,
    emitChange: () => listeners.forEach(fn => fn()),
  }
}

type MockHandle = ReturnType<typeof createHandle>

function setup() {
  const handles = new Map<string, MockHandle>()
  const find = vi.fn(async (url: string) => {
    const handle = handles.get(url) ?? createHandle(url)
    handles.set(url, handle)
    return handle
  })
  const repo = { find, handles: {} } as unknown as Repo
  const onChange = vi.fn()
  const subscriptions = new ItemSubscriptions(() => repo, onChange)
  const handleFor = (id: string) => handles.get(`automerge:${id}`)!
  return { subscriptions, find, onChange, handleFor }
}

const id = (value: string) => value as ItemId
const asDocHandle = (handle: MockHandle) => handle as unknown as DocHandle<RepoDoc>

describe('ItemSubscriptions', () => {
  it('binds a listener once per item and calls onChange when bound and on every change', async () => {
    const { subscriptions, find, onChange, handleFor } = setup()

    subscriptions.subscribe([id('a'), id('a')])
    subscriptions.subscribe([id('a')])
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))

    const handle = handleFor('a')
    expect(find).toHaveBeenCalledTimes(1)
    expect(handle.listeners.size).toBe(1)

    handle.emitChange()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('a', handle)
  })

  it('detaches the exact listener reference it attached on unsubscribe', async () => {
    const { subscriptions, onChange, handleFor } = setup()
    subscriptions.subscribe([id('a')])
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    const handle = handleFor('a')
    const attached = handle.on.mock.calls[0][1]

    subscriptions.unsubscribe(id('a'))

    expect(handle.off).toHaveBeenCalledWith('change', attached)
    expect(handle.listeners.size).toBe(0)
    expect(subscriptions.has(id('a'))).toBe(false)
  })

  it('unsubscribes from items missing from an update and detaches every listener on clear', async () => {
    const { subscriptions, onChange, handleFor } = setup()
    subscriptions.subscribe([id('a'), id('b'), id('c')])
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3))

    subscriptions.update([id('b'), id('c')])
    expect(handleFor('a').listeners.size).toBe(0)
    expect(handleFor('b').listeners.size).toBe(1)

    subscriptions.clear()
    expect(handleFor('b').listeners.size).toBe(0)
    expect(handleFor('c').listeners.size).toBe(0)
    expect(subscriptions.has(id('b'))).toBe(false)
  })

  it('moves the listener to a replacing handle only for subscribed items', async () => {
    const { subscriptions, onChange, handleFor } = setup()
    subscriptions.subscribe([id('a')])
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    const oldHandle = handleFor('a')
    const newHandle = createHandle('a2')

    subscriptions.rebind(id('a'), asDocHandle(newHandle))

    expect(oldHandle.off).toHaveBeenCalledWith('change', oldHandle.on.mock.calls[0][1])
    expect(oldHandle.listeners.size).toBe(0)
    expect(newHandle.listeners.size).toBe(1)
    expect(onChange).toHaveBeenLastCalledWith('a', newHandle)

    const unrelated = createHandle('b')
    subscriptions.rebind(id('b'), asDocHandle(unrelated))
    expect(unrelated.on).not.toHaveBeenCalled()
  })

  it('does not bind a handle found after the item was unsubscribed', async () => {
    const { subscriptions, find, onChange } = setup()
    subscriptions.subscribe([id('a')])
    subscriptions.unsubscribe(id('a'))

    await find.mock.results[0].value
    await Promise.resolve()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('subscribes again after finding the document failed', async () => {
    const { subscriptions, find, onChange } = setup()
    find.mockRejectedValueOnce(new Error('Document unavailable'))

    subscriptions.subscribe([id('a')])
    await vi.waitFor(() => expect(subscriptions.has(id('a'))).toBe(false))

    subscriptions.subscribe([id('a')])
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  })

  it('keeps the listener attached when onChange throws', async () => {
    const { subscriptions, onChange, handleFor } = setup()
    onChange.mockImplementation(() => {
      throw new Error('decode failed')
    })

    subscriptions.subscribe([id('a')])
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())

    expect(() => handleFor('a').emitChange()).not.toThrow()
    expect(handleFor('a').listeners.size).toBe(1)
  })
})
