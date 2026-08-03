import { render } from '@testing-library/react'
import SortDialog from './SortDialog'
import { checkA11y } from '../../testUtils/axe'

describe('SortDialog accessibility', () => {
  it('renders sort criteria configuration and passes accessibility audits', async () => {
    const { container } = render(
      <SortDialog open={true} onClose={() => {}} />,
    )

    await checkA11y(container)
  })
})
