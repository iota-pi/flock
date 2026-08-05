import { render } from '@testing-library/react'
import ReencryptVaultDialog from './ReencryptVaultDialog'
import { checkA11y } from '../../testUtils/axe'

describe('ReencryptVaultDialog accessibility', () => {
  it('has no accessibility violations when open', async () => {
    const { container } = render(
      <ReencryptVaultDialog open={true} onClose={() => {}} />,
    )

    await checkA11y(container)
  })
})
