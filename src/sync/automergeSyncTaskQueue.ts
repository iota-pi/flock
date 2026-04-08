export class AutomergeSyncTaskQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const nextTask = this.tail.then(task, task)

    this.tail = nextTask
      .then(() => undefined)
      .catch(() => undefined)

    return nextTask
  }

  reset(): void {
    this.tail = Promise.resolve()
  }
}