import { generateNoteId } from '../utils'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'

export function importPeople(data: Record<string, string>[]): Item[] {
  const d = new Date()
  const todaysDate = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
  const importGroup = getBlankGroup()
  importGroup.name = `Imported ${todaysDate}`

  const results: Item[] = [importGroup]

  for (const row of data) {
    const name = (row.name || `${row.firstName} ${row.lastName}`).trim()
    if (name === '') {
      continue
    }

    const blankPerson = getBlankPerson()
    results.push({
      ...blankPerson,
      name,
      description: row.description || blankPerson.description,
      notes: row.notes ? [{
        id: generateNoteId(),
        text: row.notes,
        archived: false,
        time: blankPerson.created,
      }] : blankPerson.notes,
    })

    importGroup.members.push(blankPerson.id)
  }

  return results
}
