import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  runStorageOperation,
  registerQuotaReporter,
  registerQuotaRecoveryHandler,
  clearQuotaRecoveryHandlerForTesting,
  resetQuotaExceededStatus,
} from './storageManager'

describe('storageManager', () => {
  beforeEach(() => {
    clearQuotaRecoveryHandlerForTesting()
    resetQuotaExceededStatus()
    vi.clearAllMocks()
  })

  it('executes operation normally when no error occurs', async () => {
    const result = await runStorageOperation(async () => 'success')
    expect(result).toBe('success')
  })

  it('reports quota exceeded when operation throws QuotaExceededError and no recovery handler is registered', async () => {
    const reporter = vi.fn()
    const unregister = registerQuotaReporter(reporter)

    const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
    await expect(
      runStorageOperation(async () => {
        throw quotaErr
      })
    ).rejects.toThrow('Quota exceeded')

    expect(reporter).toHaveBeenCalledWith(expect.stringContaining('Storage quota exceeded'))
    unregister()
  })

  it('attempts recovery and retries operation when QuotaRecoveryHandler is registered', async () => {
    const reporter = vi.fn()
    const unregisterReporter = registerQuotaReporter(reporter)

    let attempts = 0
    const recoveryHandler = vi.fn().mockResolvedValue(true)
    const unregisterRecovery = registerQuotaRecoveryHandler(recoveryHandler)

    const result = await runStorageOperation(async () => {
      attempts++
      if (attempts === 1) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      }
      return 'recovered-data'
    })

    expect(result).toBe('recovered-data')
    expect(attempts).toBe(2)
    expect(recoveryHandler).toHaveBeenCalledTimes(1)
    // Successful retry should NOT report quota exceeded to user
    expect(reporter).not.toHaveBeenCalled()

    unregisterReporter()
    unregisterRecovery()
  })

  it('reports quota exceeded when recovery retry still fails with QuotaExceededError', async () => {
    const reporter = vi.fn()
    const unregisterReporter = registerQuotaReporter(reporter)

    const recoveryHandler = vi.fn().mockResolvedValue(true)
    const unregisterRecovery = registerQuotaRecoveryHandler(recoveryHandler)

    await expect(
      runStorageOperation(async () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      })
    ).rejects.toThrow('Quota exceeded')

    expect(recoveryHandler).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledTimes(1)

    unregisterReporter()
    unregisterRecovery()
  })

  it('does not attempt recovery when retryOnQuotaError is false', async () => {
    const reporter = vi.fn()
    const unregisterReporter = registerQuotaReporter(reporter)

    const recoveryHandler = vi.fn().mockResolvedValue(true)
    const unregisterRecovery = registerQuotaRecoveryHandler(recoveryHandler)

    await expect(
      runStorageOperation(
        async () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        },
        { retryOnQuotaError: false }
      )
    ).rejects.toThrow('Quota exceeded')

    expect(recoveryHandler).not.toHaveBeenCalled()
    expect(reporter).toHaveBeenCalledTimes(1)

    unregisterReporter()
    unregisterRecovery()
  })
})
