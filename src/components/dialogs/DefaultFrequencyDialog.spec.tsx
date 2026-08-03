import { render } from '@testing-library/react'
import DefaultFrequencyDialog from './DefaultFrequencyDialog'
import { checkA11y } from '../../testUtils/axe'

describe('DefaultFrequencyDialog accessibility', () => {
  it('renders frequency pickers and passes accessibility audits', async () => {
    const { container } = render(
      <DefaultFrequencyDialog
        open={true}
        defaults={{ person: 'weekly', group: 'monthly' }}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    await checkA11y(container)
  })
})
