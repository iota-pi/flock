/** Builds a SET expression for the defined fields. Names go through placeholders, so app fields may be reserved words. */
export function buildDynamoUpdate(fields: Record<string, unknown>): {
  expression: string
  names: Record<string, string>
  values: Record<string, unknown>
} {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined)
  if (entries.length === 0) {
    return {
      expression: '',
      names: {},
      values: {},
    }
  }
  return {
    expression: `SET ${entries.map(([k]) => `#${k} = :${k}`).join(', ')}`,
    names: Object.fromEntries(entries.map(([k]) => [`#${k}`, k])),
    values: Object.fromEntries(entries.map(([k, v]) => [`:${k}`, v])),
  }
}
