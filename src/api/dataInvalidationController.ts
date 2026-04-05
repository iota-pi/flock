import { getQueryKey } from '@trpc/react-query'
import { queryClient } from './queryClient'
import { trpc } from './trpc'
import { subscribeAppEvents } from '../app/appEvents'

export function startDataInvalidationController(): () => void {
  return subscribeAppEvents(event => {
    if (event.type !== 'data:updated') {
      return
    }

    if (event.domain === 'items') {
      void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.items.fetchMany) })
      return
    }

    if (event.domain === 'metadata') {
      void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.accounts.getMetadata) })
    }
  })
}
