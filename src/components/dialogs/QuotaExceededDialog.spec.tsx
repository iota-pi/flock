import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import QuotaExceededDialog from './QuotaExceededDialog'
import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../sync/client/SyncBridge'

vi.mock('../../sync/client/SyncBridge', () => ({
  SyncBridge: {
    retrySave: vi.fn(),
    pushSnapshots: vi.fn().mockResolvedValue({ persisted: 1, total: 1 }),
    flushSync: vi.fn().mockResolvedValue(undefined),
  },
}))

describe('QuotaExceededDialog', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({
        syncStatus: 'degraded',
        isQuotaExceeded: true,
        items: {
          'item-1': { id: 'item-1', name: 'Prayer Request 1', type: 'person' } as any,
        },
      })
    })
  })

  it('renders dialog with warning and three recovery options', () => {
    render(<QuotaExceededDialog open={true} onClose={onClose} />)

    expect(screen.getByText(/Storage Full: Changes Stored in Memory Only/i)).toBeDefined()
    expect(screen.getByText(/Option 1: Free Up Device Space & Retry Save/i)).toBeDefined()
    expect(screen.getByText(/Option 2: Sync to Cloud Server/i)).toBeDefined()
    expect(screen.getByText(/Option 3: Emergency Data Backup/i)).toBeDefined()
  })

  it('handles Retry Save success flow', async () => {
    vi.mocked(SyncBridge.retrySave).mockResolvedValueOnce({ success: true })

    render(<QuotaExceededDialog open={true} onClose={onClose} />)
    const retryBtn = screen.getByRole('button', { name: /retry save/i })
    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(screen.getByText(/Changes successfully saved to this device!/i)).toBeDefined()
    })
  })

  it('handles Retry Save failure flow', async () => {
    vi.mocked(SyncBridge.retrySave).mockResolvedValueOnce({
      success: false,
      error: 'Storage quota is still exceeded.',
    })

    render(<QuotaExceededDialog open={true} onClose={onClose} />)
    const retryBtn = screen.getByRole('button', { name: /retry save/i })
    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(screen.getByText(/Storage quota is still exceeded/i)).toBeDefined()
    })
  })

  it('handles Sync to Cloud Now when online', async () => {
    render(<QuotaExceededDialog open={true} onClose={onClose} />)
    const syncBtn = screen.getByRole('button', { name: /sync to cloud now/i })
    fireEvent.click(syncBtn)

    await waitFor(() => {
      expect(SyncBridge.pushSnapshots).toHaveBeenCalled()
      expect(SyncBridge.flushSync).toHaveBeenCalled()
      expect(screen.getByText(/Cloud sync initiated successfully!/i)).toBeDefined()
    })
  })

  it('handles emergency copy backup to clipboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    })

    render(<QuotaExceededDialog open={true} onClose={onClose} />)
    const copyBtn = screen.getByRole('button', { name: /copy data to clipboard/i })
    fireEvent.click(copyBtn)

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('Prayer Request 1'))
      expect(screen.getByText(/Copied to Clipboard!/i)).toBeDefined()
    })
  })

  it('calls onClose when close button is clicked', () => {
    render(<QuotaExceededDialog open={true} onClose={onClose} />)
    const closeBtn = screen.getByRole('button', { name: /close \(keep in memory\)/i })
    fireEvent.click(closeBtn)

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
