import { generateItemId } from '../utils'
import { getBlankGroup, getBlankPerson, type Item } from '../state/items'
import { setCachedAutomergeBinary } from '../api/automergeBinaryCache'
import { seedAutomergeBinaryWithWorker } from '../workers/itemWorkerManager'

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
        id: generateItemId(),
        text: row.notes,
        archived: false,
        time: blankPerson.created,
      }] : blankPerson.notes,
    })

    importGroup.members.push(blankPerson.id)
  }

  return results
}

export async function importPeopleWithAutomergeSeed(data: Record<string, string>[]): Promise<Item[]> {
  const items = importPeople(data)
  const seeded = await seedAutomergeBinaryWithWorker(items)
  for (const entry of seeded) {
    setCachedAutomergeBinary(entry.id, entry.binary)
  }
  return items
}
