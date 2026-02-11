/**
 * mutationCache.ts
 *
 * The MutationCache holds every active Mutation instance and is the single
 * source of truth for mutation lifecycle events.
 *
 * Key design decisions vs. QueryCache:
 *
 * - No deduplication: every useMutation / build() call creates a fresh
 *   Mutation instance. Two concurrent mutations with the same key are both
 *   tracked independently. This differs from QueryCache, which merges
 *   duplicates by hash. The backing store is a Set<Mutation> rather than a
 *   Map<hash, Mutation> to make this explicit.
 *
 * - Set over Array: using a Set means O(1) add/delete for remove() and
 *   clear() and no index bookkeeping. The iteration order is insertion order,
 *   which gives resumePausedMutations() its required sequential behaviour.
 *
 * - MutationCacheInterface satisfaction: Mutation.execute() calls
 *   this.#cache.config.onSuccess / onError / onSettled / onMutate (the global
 *   hooks). The config property type must satisfy MutationCacheInterface.config
 *   — the interface uses generics on each callback, but the concrete
 *   MutationCacheConfig uses `unknown` at the erased boundary, which is safe
 *   because Mutation.execute() calls the hooks with the correct concrete types
 *   and TypeScript's type erasure handles the mismatch at the `as` cast site
 *   in the implementation (none needed here — the `unknown` signature accepts
 *   any concrete call).
 *
 * - notify() goes through notifyManager.batch() so that multiple consecutive
 *   cache events (e.g. build + observer notification during the same tick)
 *   are collapsed into a single scheduler flush, preventing render cascades.
 *
 * - resumePausedMutations() is deliberately sequential (await in a for…of
 *   loop). Paused mutations should be retried in submission order. Using
 *   Promise.all() would race them and could reorder server-side effects.
 */

import { Subscribable } from './subscribable'
import { Mutation } from './mutation'
import type { MutationCacheInterface, MutationCacheNotifyEvent } from './mutation'
import type { MutationOptions, MutationStatus, QueryKey } from './types'
import { notifyManager } from './notifyManager'
import { matchesQueryKey } from './utils'

// ---------------------------------------------------------------------------
// MutationCacheConfig — global lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Global callbacks passed to the MutationCache constructor.
 *
 * These run after the per-mutation callbacks (defined in MutationOptions) for
 * every mutation managed by this cache. Use them for cross-cutting concerns:
 * - onSuccess: invalidate related queries, show a global success toast
 * - onError: report to an error monitoring service
 * - onSettled: hide a global loading indicator
 * - onMutate: show a global loading indicator before the mutationFn fires
 *
 * Each callback is itself generic over the mutation's type parameters. This
 * matches the shape declared in MutationCacheInterface.config (mutation.ts),
 * which TypeScript requires for the `implements` clause to type-check.
 *
 * Using per-function generics (rather than fixed `unknown` parameters) lets
 * callers that care about specific types write type-safe global hooks while
 * still allowing the common case of ignoring the parameters entirely. The
 * concrete types are threaded through from Mutation.execute() at the call site.
 */
export interface MutationCacheConfig {
  onError?: <TData, TError, TVariables, TContext>(
    error: TError,
    variables: TVariables,
    context: TContext | undefined,
    mutation: Mutation<TData, TError, TVariables, TContext>,
  ) => Promise<unknown> | unknown
  onSuccess?: <TData, TError, TVariables, TContext>(
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
    mutation: Mutation<TData, TError, TVariables, TContext>,
  ) => Promise<unknown> | unknown
  onSettled?: <TData, TError, TVariables, TContext>(
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
    mutation: Mutation<TData, TError, TVariables, TContext>,
  ) => Promise<unknown> | unknown
  onMutate?: <TData, TError, TVariables, TContext>(
    variables: TVariables,
    mutation: Mutation<TData, TError, TVariables, TContext>,
  ) => Promise<unknown> | unknown
}

// ---------------------------------------------------------------------------
// MutationCacheListener — subscriber type
// ---------------------------------------------------------------------------

/**
 * The function signature that MutationCache subscribers must implement.
 *
 * Called by MutationCache.notify() (via notifyManager.batch()) whenever a
 * mutation is added, removed, or its state is updated. Primary consumers:
 * DevTools panels, test utilities, and logging middleware.
 */
export type MutationCacheListener = (event: MutationCacheNotifyEvent) => void

// ---------------------------------------------------------------------------
// MutationFilters — used by find() / findAll()
// ---------------------------------------------------------------------------

/**
 * Criteria for finding mutations in the cache.
 *
 * All filters are ANDed together — a mutation must satisfy every provided
 * criterion to be included in the result.
 */
export interface MutationFilters {
  /**
   * Filter by mutation key.
   * When `exact` is false (the default), partial prefix matching is used
   * (e.g. `['todos']` matches `['todos', 1]`).
   * When `exact` is true, the key hashes must be identical.
   */
  mutationKey?: QueryKey
  /**
   * When true, mutationKey matching is exact (full hash equality).
   * When false (default for find/findAll), prefix matching is used.
   * Note: build() sets exact: true internally for find() since each mutation
   * instance is unique — callers usually want findAll() for key-based lookups.
   */
  exact?: boolean
  /** Filter by current lifecycle status. */
  status?: MutationStatus
  /** Arbitrary predicate for cases not covered by the other filters. */
  predicate?: (mutation: Mutation) => boolean
}

// ---------------------------------------------------------------------------
// MutationClientInterface — the narrow slice MutationCache needs from QueryClient
// ---------------------------------------------------------------------------

/**
 * Minimal interface that MutationCache.build() requires from the QueryClient.
 *
 * Using a narrow interface here avoids a circular dependency between
 * MutationCache and QueryClient. QueryClient will implement this interface;
 * unit tests can supply a lightweight mock.
 */
export interface MutationClientInterface {
  /**
   * Merge the client's defaultOptions.mutations with per-mutation options,
   * returning a fully-resolved MutationOptions object.
   *
   * The client applies lower-priority defaults; per-mutation options win
   * on any key they specify.
   */
  defaultMutationOptions<TData, TError, TVariables, TContext>(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): MutationOptions<TData, TError, TVariables, TContext>
}

// ---------------------------------------------------------------------------
// matchesMutation — private module-level helper
// ---------------------------------------------------------------------------

/**
 * Returns true if `mutation` satisfies every criterion in `filters`.
 *
 * Called by both find() and findAll(). Keeping this as a module-level
 * function (rather than a method) makes it trivial to unit-test in isolation.
 */
function matchesMutation(mutation: Mutation, filters: MutationFilters): boolean {
  const { mutationKey, exact = false, status, predicate } = filters

  // Key filter: if a key is specified, the mutation must have a mutationKey
  // AND it must match according to the exact / partial rules.
  if (mutationKey !== undefined) {
    if (!mutation.options.mutationKey) return false
    if (!matchesQueryKey(mutation.options.mutationKey, mutationKey, exact)) {
      return false
    }
  }

  // Status filter: simple equality check against the state machine's status.
  if (status !== undefined && mutation.state.status !== status) {
    return false
  }

  // Predicate filter: caller-provided boolean function for anything else.
  if (predicate && !predicate(mutation)) {
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// MutationCache
// ---------------------------------------------------------------------------

/**
 * The collection of all active Mutation instances.
 *
 * Responsibilities:
 * 1. Lifecycle management: create (build), remove, and clear mutations.
 * 2. Lookup: find() / findAll() with flexible filter criteria.
 * 3. Event fan-out: notify() distributes MutationCacheNotifyEvents to all
 *    subscribers (DevTools, test utilities, etc.) via notifyManager.batch().
 * 4. Network recovery: resumePausedMutations() replays paused mutations in
 *    submission order when the network comes back online.
 * 5. Global hooks: exposes `config` so Mutation.execute() can call the
 *    cache-level onSuccess / onError / onSettled / onMutate callbacks.
 *
 * Implements MutationCacheInterface (defined in mutation.ts) so Mutation
 * instances can call back into the cache without importing the full class
 * (which would be circular). The interface is narrow by design.
 */
export class MutationCache
  extends Subscribable<MutationCacheListener>
  implements MutationCacheInterface
{
  /**
   * All currently tracked Mutation instances.
   *
   * A Set is used instead of an Array because:
   * - add() and delete() are O(1) vs O(n) splice for Arrays.
   * - No index juggling is needed when removing mid-collection.
   * - Iteration is insertion-ordered, giving resumePausedMutations() the
   *   deterministic sequential replay order it needs.
   * - Mutations are NOT deduplicated by key (unlike queries), so a plain
   *   Set of object references is the correct structure.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #mutations: Set<Mutation<any, any, any, any>>

  /**
   * Global lifecycle hooks and cache-level configuration.
   *
   * Mutation.execute() reads `this.#cache.config` to call the global callbacks
   * after the per-mutation ones complete. Exposing `config` publicly (rather
   * than via getter methods) keeps the interface consistent with how QueryCache
   * and QueryClient expose their configuration.
   */
  config: MutationCacheConfig

  constructor(config: MutationCacheConfig = {}) {
    super()
    this.config = config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.#mutations = new Set<Mutation<any, any, any, any>>()
  }

  // ---------------------------------------------------------------------------
  // Mutation lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create a new Mutation instance, add it to the cache, and notify listeners.
   *
   * Unlike QueryCache.getOrCreate(), this method ALWAYS creates a fresh
   * Mutation. There is no deduplication by key — each useMutation call that
   * triggers a mutation gets its own instance with its own state machine.
   *
   * The client's `defaultMutationOptions` is applied here (before the Mutation
   * constructor runs) so the instance receives a fully-resolved options object.
   *
   * @param client - The QueryClient (or a compatible mock). Used only to call
   *                 defaultMutationOptions().
   * @param options - Per-mutation options from the useMutation call site.
   * @returns The new Mutation instance, typed with the caller's type parameters.
   */
  build<TData = unknown, TError = Error, TVariables = unknown, TContext = unknown>(
    client: MutationClientInterface,
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): Mutation<TData, TError, TVariables, TContext> {
    const mutation = new Mutation<TData, TError, TVariables, TContext>({
      mutationCache: this,
      options: client.defaultMutationOptions(options),
    })

    this.#mutations.add(mutation)

    // Notify subscribers that a new mutation was added to the cache. The cast
    // to `Mutation` (erased) is required by MutationCacheNotifyEvent which uses
    // `any` type params at the cache boundary to avoid recursive type
    // instantiation. The actual instance is fully typed — only the event payload
    // is erased.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.notify({ type: 'added', mutation: mutation as unknown as Mutation<any, any, any, any> })

    return mutation
  }

  /**
   * Remove a specific mutation from the cache.
   *
   * Called by:
   * - Mutation.optionalRemove() after the GC timeout fires (gcTime elapsed
   *   with no observers).
   * - Imperative cache management (e.g. test teardown).
   *
   * Notifies listeners so DevTools panels can remove the entry from their UI.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  remove(mutation: Mutation<any, any, any, any>): void {
    this.#mutations.delete(mutation)
    this.notify({ type: 'removed', mutation })
  }

  /**
   * Destroy all mutations and empty the cache.
   *
   * Calls mutation.destroy() on each instance to cancel any pending GC
   * timeouts before clearing the Set. This prevents optionalRemove() from
   * firing on already-removed instances after clear() returns.
   *
   * Does NOT emit per-mutation 'removed' events — the intent is a full reset,
   * not incremental teardown (e.g. on QueryClient.clear()).
   */
  clear(): void {
    this.#mutations.forEach((mutation) => mutation.destroy())
    this.#mutations.clear()
  }

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  /**
   * Return all tracked mutations as a plain array.
   *
   * The spread converts the Set's iterator into a stable Array snapshot.
   * Callers get a new array each time, so they can freely mutate it without
   * affecting the internal Set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAll(): Mutation<any, any, any, any>[] {
    return [...this.#mutations]
  }

  /**
   * Find the first mutation that satisfies all given filters.
   *
   * `exact` defaults to true here (unlike findAll) because find() is typically
   * called when looking for a specific mutation by key — an exact match is
   * almost always what callers want. Callers can pass `exact: false` explicitly
   * for prefix matching.
   *
   * Returns undefined if no match is found.
   */
  find<TData = unknown, TError = Error, TVariables = unknown, TContext = unknown>(
    filters: MutationFilters,
  ): Mutation<TData, TError, TVariables, TContext> | undefined {
    // find() defaults exact: true so key lookups are unambiguous.
    const defaultedFilters: MutationFilters = { exact: true, ...filters }
    return this.getAll().find((mutation) =>
      matchesMutation(mutation, defaultedFilters),
    ) as Mutation<TData, TError, TVariables, TContext> | undefined
  }

  /**
   * Find all mutations that satisfy all given filters.
   *
   * `exact` defaults to false (partial prefix matching) for findAll() since
   * callers typically want all mutations under a key prefix
   * (e.g. all ['todos', …] mutations).
   *
   * Returns an empty array if no matches are found.
   */
  findAll(filters: MutationFilters = {}): Mutation[] {
    return this.getAll().filter((mutation) => matchesMutation(mutation, filters))
  }

  // ---------------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a cache-level event to all subscribers.
   *
   * Wrapped in notifyManager.batch() so that multiple events emitted during
   * a single synchronous execution (e.g. build() + the subsequent state
   * transition in execute()) are flushed to subscribers as a single batch,
   * preventing duplicate React renders.
   *
   * This method satisfies the MutationCacheInterface.notify() contract that
   * Mutation instances call back into.
   */
  notify(event: MutationCacheNotifyEvent): void {
    notifyManager.batch(() => {
      this.listeners.forEach((listener) => listener(event))
    })
  }

  // ---------------------------------------------------------------------------
  // Network recovery
  // ---------------------------------------------------------------------------

  /**
   * Resume all mutations that are paused (waiting for network connectivity).
   *
   * Called by OnlineManager when the browser comes back online. Iterates over
   * paused mutations in insertion order and awaits each one before starting
   * the next. The sequential (for…of + await) strategy is intentional:
   *
   * - Ordering: mutations submitted earlier re-execute first, preserving the
   *   user's intended operation order (e.g. create-then-update sequences).
   * - Isolation: a failure in one mutation does not abort the others (the
   *   error is swallowed here; Mutation.execute() has already dispatched the
   *   'error' action and notified observers).
   * - Simplicity: no Promise.all() race conditions or partial-failure handling
   *   to reason about.
   *
   * Only mutations whose `state.variables` is not undefined are resumed —
   * a mutation with undefined variables was never fully submitted and cannot
   * be replayed.
   */
  async resumePausedMutations(): Promise<void> {
    // Snapshot the paused set before iteration — new mutations added while we
    // are resuming should not be part of this recovery pass.
    const pausedMutations = this.getAll().filter((m) => m.state.isPaused)

    for (const mutation of pausedMutations) {
      // Only replay mutations that have a recorded variables value. A mutation
      // without variables was paused before it could even start; there is
      // nothing meaningful to replay.
      if (mutation.state.variables !== undefined) {
        // Errors are intentionally not awaited to propagate — execute() already
        // handles the error path internally (dispatches 'error', calls hooks).
        // We catch here purely to allow subsequent paused mutations to proceed.
        await mutation.execute(mutation.state.variables).catch(() => {
          // Swallow: the error has already been surfaced to the mutation's
          // observers and global onError hooks inside execute().
        })
      }
    }
  }
}
