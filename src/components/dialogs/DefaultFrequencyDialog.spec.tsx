import { render, screen } from '@testing-library/react'
import DefaultFrequencyDialog from './DefaultFrequencyDialog'
import { checkA11y } from '../../testUtils/axe'

describe('DefaultFrequencyDialog accessibility', () => {
  it('renders frequency pickers for people, groups, and topics and passes accessibility audits', async () => {
    const { container } = render(
      <DefaultFrequencyDialog
        open={true}
        defaults={{ person: 'weekly', group: 'monthly', topic: 'daily' }}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    expect(screen.getByText('People')).toBeTruthy()
    expect(screen.getByText('Groups')).toBeTruthy()
    expect(screen.getByText('Topics')).toBeTruthy()

    await checkA11y(container)
  })

  it('defaults fallback frequency to No target (none) when defaults are missing', () => {
    render(
      <DefaultFrequencyDialog
        open={true}
        defaults={{}}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    const noTargetElements = screen.getAllByText('No target')
    expect(noTargetElements.length).toBeGreaterThanOrEqual(3)
  })
})
