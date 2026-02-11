/**
 * index.ts — Barrel export for the core module.
 *
 * Files are listed in dependency order (lowest-level first) for readability.
 * Selective re-exports are used where multiple files define interfaces with
 * the same name (e.g. QueryClientInterface) to avoid ambiguous re-export errors.
 */

// Shared TypeScript types and interfaces (no runtime code)
export * from './types'

// Pure utility functions (no side effects, no class state)
export * from './utils'

// Observer pattern base class
export * from './subscribable'

// Batched notification singleton
export * from './notifyManager'

// GC-aware base class for Query and Mutation
export * from './removable'

// Retry engine — exponential backoff, offline pausing, cancellation
export * from './retryer'

// Browser event singletons — focus/visibility and network online/offline
export * from './focusManager'
export * from './onlineManager'

// Cache entry and state machine — the heart of the query system
export * from './query'

// Mutation state machine, lifecycle hooks, and supporting interfaces
export * from './mutation'

// In-memory registry of all Query instances — find/build/remove/notify
// NOTE: QueryClientInterface from queryCache is intentionally not re-exported here
// to avoid conflict with the one in queryObserver. Use direct imports when needed.
export { QueryCache } from './queryCache'
export type { QueryCacheConfig, QueryCacheListener, QueryClientInterface as QueryCacheClientInterface } from './queryCache'

// In-memory registry of all Mutation instances — build/remove/notify/resume
export { MutationCache } from './mutationCache'
export type { MutationCacheConfig, MutationCacheListener, MutationFilters, MutationClientInterface as MutationCacheClientInterface } from './mutationCache'

// Observer bridges — connect cache entries to React components
export * from './queryObserver'
export * from './mutationObserver'

// Public API facade — the single object users interact with
export { QueryClient } from './queryClient'
export type { QueryClientConfig } from './queryClient'
