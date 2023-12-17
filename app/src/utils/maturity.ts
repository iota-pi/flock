import { storeItems } from '../api/Vault'
import { PersonItem } from '../state/items'

export interface MaturityControl {
  id: string,
  name: string,
}

export async function updateMaturityForPeople(
  people: PersonItem[],
  original: MaturityControl[],
  updated: MaturityControl[],
) {
  const map = new Map<string, PersonItem[]>()
  people.forEach(person => {
    if (person.maturity) {
      const existing = map.get(person.maturity) || []
      map.set(person.maturity, [...existing, person])
    }
  })
  const updatedPeople: PersonItem[] = []
  for (const stage of updated) {
    const originalStage = original.find(({ id }) => id === stage.id)
    if (originalStage && stage.name !== originalStage.name) {
      const peopleWithMaturity = map.get(originalStage.name) || []
      updatedPeople.push(
        ...peopleWithMaturity.map(p => ({ ...p, maturity: stage.name.trim() })),
      )
    }
  }
  await storeItems(updatedPeople)
}
