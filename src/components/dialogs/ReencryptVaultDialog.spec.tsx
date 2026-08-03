import { render } from '@testing-library/react'
import { axe } from 'vitest-axe'
import ReencryptVaultDialog from './ReencryptVaultDialog'

describe('ReencryptVaultDialog accessibility', () => {
  it('has no accessibility violations when open', async () => {
    const { container } = render(
      <ReencryptVaultDialog open={true} onClose={() => {}} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
