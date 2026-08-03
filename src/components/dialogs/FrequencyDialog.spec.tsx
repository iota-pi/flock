import { render } from '@testing-library/react'
import FrequencyDialog from './FrequencyDialog'
import { checkA11y } from '../../testUtils/axe'

describe('FrequencyDialog accessibility', () => {
  it('renders frequency picker and passes accessibility audits', async () => {
    const { container } = render(
      <FrequencyDialog items={[]} open={true} onClose={() => {}} />,
    )

    await checkA11y(container)
  })
})
