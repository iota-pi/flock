import { run as runAxe } from 'axe-core'

export async function checkA11y(container: Element) {
  const results = await runAxe(container)
  const violations = results.violations.map(
    v => `${v.id}(${v.impact}): ${v.help} [${v.nodes.map(n => n.html).join(', ')}]`,
  )
  expect(violations).toEqual([])
}
