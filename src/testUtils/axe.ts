import axe from 'axe-core'
import { expect } from 'vitest'

export async function checkA11y(container: Element) {
  const results = await axe.run(container)
  const violations = results.violations.map(
    v => `${v.id}(${v.impact}): ${v.help} [${v.nodes.map(n => n.html).join(', ')}]`,
  )
  expect(violations).toEqual([])
}
