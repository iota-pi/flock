import { AsyncMutex, KeyedAsyncMutex } from './AsyncMutex'

describe('AsyncMutex', () => {
  it('executes tasks sequentially in FIFO order', async () => {
    const mutex = new AsyncMutex()
    const order: number[] = []

    const p1 = mutex.runExclusive(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push(1)
      return 'one'
    })

    const p2 = mutex.runExclusive(async () => {
      order.push(2)
      return 'two'
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
    expect(r1).toBe('one')
    expect(r2).toBe('two')
  })

  it('continues execution after a task rejects', async () => {
    const mutex = new AsyncMutex()
    const p1 = mutex.runExclusive(async () => {
      throw new Error('Task failed')
    })
    const p2 = mutex.runExclusive(async () => {
      return 'recovered'
    })

    await expect(p1).rejects.toThrow('Task failed')
    const r2 = await p2
    expect(r2).toBe('recovered')
  })

  it('waitForIdle awaits all active tasks', async () => {
    const mutex = new AsyncMutex()
    let completed = false

    void mutex.runExclusive(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      completed = true
    })

    expect(completed).toBe(false)
    await mutex.waitForIdle()
    expect(completed).toBe(true)
  })
})

describe('KeyedAsyncMutex', () => {
  it('executes tasks for the same key sequentially', async () => {
    const mutex = new KeyedAsyncMutex<string>()
    const order: number[] = []

    const p1 = mutex.runExclusive('keyA', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push(1)
      return 'a1'
    })

    const p2 = mutex.runExclusive('keyA', async () => {
      order.push(2)
      return 'a2'
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
    expect(r1).toBe('a1')
    expect(r2).toBe('a2')
  })

  it('executes tasks for different keys concurrently', async () => {
    const mutex = new KeyedAsyncMutex<string>()
    const order: string[] = []

    const p1 = mutex.runExclusive('keyA', async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      order.push('A')
    })

    const p2 = mutex.runExclusive('keyB', async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push('B')
    })

    await Promise.all([p1, p2])
    expect(order).toEqual(['B', 'A'])
  })

  it('cleans up the key on completion', async () => {
    const mutex = new KeyedAsyncMutex<string>()
    let runs = 0

    await mutex.runExclusive('item1', async () => {
      runs += 1
    })

    await mutex.runExclusive('item1', async () => {
      runs += 1
    })

    expect(runs).toBe(2)
  })

  it('continues subsequent tasks for the key after a failure', async () => {
    const mutex = new KeyedAsyncMutex<string>()

    const p1 = mutex.runExclusive('item1', async () => {
      throw new Error('Lock failure')
    })
    const p2 = mutex.runExclusive('item1', async () => {
      return 'success'
    })

    await expect(p1).rejects.toThrow('Lock failure')
    expect(await p2).toBe('success')
  })

  it('supports waitForIdle(key)', async () => {
    const mutex = new KeyedAsyncMutex<string>()
    let done = false

    void mutex.runExclusive('doc1', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      done = true
    })

    expect(done).toBe(false)
    await mutex.waitForIdle('doc1')
    expect(done).toBe(true)
  })

  it('supports clear()', async () => {
    const mutex = new KeyedAsyncMutex<string>()
    let release!: () => void
    const task = new Promise<void>(r => { release = r })

    void mutex.runExclusive('a', () => task)
    mutex.clear('a')
    release()
  })
})
