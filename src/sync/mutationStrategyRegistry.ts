import type { QueuedMutation } from './offlineQueueStore'

export type RegisteredMutationStrategy = {
  execute: (mutation: QueuedMutation) => Promise<void>
}

const registry = new Map<string, RegisteredMutationStrategy>()

export function registerMutationStrategy(
  mutationType: string,
  strategy: RegisteredMutationStrategy,
): void {
  registry.set(mutationType, strategy)
}

export function getRegisteredMutationStrategy(
  mutationType: string,
): RegisteredMutationStrategy | undefined {
  return registry.get(mutationType)
}

export function clearMutationStrategyRegistry(): void {
  registry.clear()
}