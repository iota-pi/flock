import { getQueryKey } from '@trpc/react-query'
import { queryClient } from './queryClient'
import { trpc } from './trpc'
import { subscribeDomainEvents } from '../events/domainEvents'

export function startDataInvalidationController(): () => void {
  return subscribeDomainEvents(event => {
    if (
      event.type === 'data:updated'
      && event.domain === 'items'
    ) {
      void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.items.fetchMany) })
      return
    }

    if (
      event.type === 'data:updated'
      && event.domain === 'metadata'
    ) {
      void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.accounts.getMetadata) })
      return
    }

    if (event.type === 'sync:item-recovered') {
      void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.items.fetchMany) })
    }
  })
}
