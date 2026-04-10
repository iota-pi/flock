import { useDocument } from '@automerge/automerge-repo-react-hooks'
import type { Item } from '../state/items'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'

export function useAutomergeItem(itemId: string): Item | null {
  const [item] = useDocument<Item>(toAutomergeUrlFromItemId(itemId), {
    suspense: false,
  })

  return item || null
}
