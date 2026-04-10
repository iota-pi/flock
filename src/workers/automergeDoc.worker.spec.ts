import * as Automerge from '@automerge/automerge'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposeSpy = vi.hoisted(() => vi.fn())

vi.mock('comlink', () => ({
  expose: exposeSpy,
  transfer: (value: unknown) => value,
}))

type WorkerApi = {
  reset: () => void
  loadPersistedRecord: (record: {
    itemId: string
    doc: Uint8Array
    syncState: Uint8Array
    cursor?: number
  }) => {
    documentId: string
    snapshot: Record<string, unknown>
    serialized: {
      doc: Uint8Array
      syncState: Uint8Array
      cursor: number
    }
  } | null
  setSnapshot: (input: {
    documentId: string
    snapshot: Record<string, unknown>
    cursor?: number
    syncState?: Uint8Array
  }) => {
    documentId: string
    snapshot: Record<string, unknown>
    serialized: {
      doc: Uint8Array
      syncState: Uint8Array
      cursor: number
    }
  }
}

async function loadWorkerApi(): Promise<WorkerApi> {
  await import('./automergeDoc.worker')

  const exposed = exposeSpy.mock.calls.at(-1)?.[0] as WorkerApi | undefined
  if (!exposed) {
    throw new Error('Expected worker API to be exposed')
  }

  return exposed
}

describe('automergeDoc.worker setSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('preserves concurrent nested edits when a snapshot updates only top-level fields', async () => {
    const workerApi = await loadWorkerApi()

    const initialSnapshot = {
      id: 'item-1',
      type: 'person',
      name: 'Alice',
      notes: [
        { id: 'note-1', text: 'Initial note' },
      ],
    }

    const baseEntry = workerApi.setSnapshot({
      documentId: 'item-1',
      snapshot: initialSnapshot,
    })

    const remoteDocBase = Automerge.load<Record<string, unknown>>(baseEntry.serialized.doc)
    const remoteDoc = Automerge.change(remoteDocBase, draft => {
      const notes = (draft as Record<string, unknown>).notes as Array<{ id: string; text: string }>
      notes.push({
        id: 'note-2',
        text: 'Added remotely',
      })
    })

    workerApi.reset()
    workerApi.loadPersistedRecord({
      itemId: 'item-1',
      doc: baseEntry.serialized.doc,
      syncState: baseEntry.serialized.syncState,
      cursor: baseEntry.serialized.cursor,
    })

    const localEntry = workerApi.setSnapshot({
      documentId: 'item-1',
      snapshot: {
        ...initialSnapshot,
        name: 'Alice Updated Locally',
      },
      cursor: baseEntry.serialized.cursor,
      syncState: baseEntry.serialized.syncState,
    })

    const merged = Automerge.merge(
      Automerge.load<Record<string, unknown>>(localEntry.serialized.doc),
      remoteDoc,
    )
    const mergedSnapshot = Automerge.toJS(merged) as {
      name: string
      notes: Array<{ id: string; text: string }>
    }

    expect(mergedSnapshot.name).toBe('Alice Updated Locally')
    expect(mergedSnapshot.notes.map(note => note.id)).toContain('note-2')
  })
})
