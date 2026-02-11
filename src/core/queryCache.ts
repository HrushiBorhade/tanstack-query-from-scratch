/**
 * queryCache.ts
 *
 * The in-memory registry of all Query instances.
 *
 * Responsibilities:
 * - Acts as the sole factory for Query objects (via build()). No code outside
 *   this file should ever call `new Query(...)` directly.
 * - Maintains the canonical Map<QueryHash, Query> — one entry per unique key.
 * - Notifies subscribers (DevTools, React adapter) about cache-level events:
 *   queries being added, removed, or updated.
 * - Bridges browser events (window focus, network online) back into the query
 *   lifecycle by forwarding them to every live Query / Observer.
 * - Implements QueryCacheInterface (defined in query.ts) so the Query class can
 *   call back into the cache without creating a circular import.
 *
 * Circular-dependency resolution:
 *   query.ts  →  QueryCacheInterface  (minimal interface, not the full class)
 *   queryCache.ts  →  Query class (concrete class, safe to import)
 *   The interface lives in query.ts so query.ts never needs to import this file.
 *
 * Design decisions:
 * - Private `#queries` Map is the ONLY storage structure — no secondary arrays.
 * - `notify()` always goes through `notifyManager.batch()` to prevent React
 *   from re-rendering once per listener instead of once per event.
 * - `matchesQuery` is a module-level pure function, not a class method, to keep
 *   it independently testable without instantiating a QueryCache.
 * - `QueryClientInterface` is defined locally (not in types.ts) to avoid a
 *   third circular dependency chain: queryCache → queryClient → queryCache.
 */

import type { QueryKey, QueryHash, QueryOptions, QueryFilters } from './types'
import { Subscribable } from './subscribable'
import { notifyManager } from './notifyManager'
import { hashQueryKey, matchesQueryKey } from './utils'
import { Query } from './query'
import type { QueryCacheInterface, QueryCacheNotifyEvent } from './query'

// ---------------------------------------------------------------------------
// QueryClientInterface — local minimal contract to avoid circular deps
// ---------------------------------------------------------------------------

/**
 * The minimal slice of QueryClient that QueryCache.build() requires.
 *
 * Defined here rather than in queryClient.ts to prevent the cycle:
 *   queryClient.ts imports QueryCache
 *   QueryCache imports QueryClient ← cycle
 *
 * QueryClient satisfies this structural interface when it is implemented.
 */
export interface QueryClientInterface {
  defaultQueryOptions<TData, TError, TQueryKey extends QueryKey>(
    options: QueryOptions<TData, TError, TQueryKey>,
  ): QueryOptions<TData, TError, TQueryKey>
}

// ---------------------------------------------------------------------------
// QueryCacheConfig
// ---------------------------------------------------------------------------

/**
 * Global callbacks that fire for every query managed by this cache.
 *
 * These are the cache-level equivalents of the per-query onError / onSuccess /
 * onSettled callbacks. They run in addition to (not instead of) any callbacks
 * defined on individual QueryOptions.
 */
export interface QueryCacheConfig {
  /** Called whenever any query in the cache enters the 'error' state. */
  onError?: (error: unknown, query: Query) => void
  /** Called whenever any query in the cache enters the 'success' state. */
  onSuccess?: (data: unknown, query: Query) => void
  /** Called after any query settles (either success or error). */
  onSettled?: (data: unknown, error: unknown, query: Query) => void
}

// ---------------------------------------------------------------------------
// QueryCacheListener
// ---------------------------------------------------------------------------

/**
 * The function signature for callbacks passed to `cache.subscribe(listener)`.
 *
 * The generic parameters are erased to `unknown / Error` at the cache boundary
 * because the cache stores heterogeneous Query instances. Subscribers (DevTools,
 * React adapter) receive the event and cast to the specific type they care about.
 */
export type QueryCacheListener = (event: QueryCacheNotifyEvent) => void

// ---------------------------------------------------------------------------
// matchesQuery — module-level pure filter function
// ---------------------------------------------------------------------------

/**
 * Returns true when `query` satisfies every criterion in `filters`.
 *
 * This is intentionally a pure module-level function (not a QueryCache method)
 * so it can be unit-tested in isolation without an instantiated cache.
 *
 * Filter application order (short-circuits on first failure):
 *  1. queryKey  — exact or prefix match via matchesQueryKey()
 *  2. type      — active (has observers) / inactive (no observers) / all
 *  3. stale     — query.isStaleByTime(0) compared to requested staleness
 *  4. fetchStatus — direct equality check on query.state.fetchStatus
 *  5. predicate — arbitrary user-supplied callback for custom logic
 */
function matchesQuery(
  query: Query,
  filters: QueryFilters,
): boolean {
  const {
    queryKey,
    exact = false,
    type = 'all',
    stale,
    fetchStatus,
    predicate,
  } = filters

  // 1. Key-based filtering
  if (queryKey !== undefined) {
    if (!matchesQueryKey(query.queryKey, queryKey, exact)) {
      return false
    }
  }

  // 2. Observer-presence filtering
  //    'active'   — at least one observer is attached
  //    'inactive' — no observers (eligible for GC)
  //    'all'      — skip this check
  if (type !== 'all') {
    const isActive = query.observers.length > 0
    if (type === 'active' && !isActive) return false
    if (type === 'inactive' && isActive) return false
  }

  // 3. Staleness filtering
  //    isStaleByTime(0) uses the most conservative check (staleTime = 0 ms),
  //    meaning "is the data stale right now, ignoring any configured staleTime".
  if (stale !== undefined) {
    const isStale = query.isStaleByTime(0)
    if (stale !== isStale) return false
  }

  // 4. Fetch-status filtering
  if (fetchStatus !== undefined && query.state.fetchStatus !== fetchStatus) {
    return false
  }

  // 5. Arbitrary predicate
  //    The predicate receives a structurally typed subset of Query so it works
  //    with the QueryFilters.predicate signature from types.ts without needing
  //    an import of the full Query class on the consumer side.
  if (predicate && !predicate(query)) {
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// QueryCache
// ---------------------------------------------------------------------------

/**
 * The central in-memory registry for all Query instances.
 *
 * QueryCache extends Subscribable<QueryCacheListener> so that external
 * consumers (DevTools, React adapter) can subscribe to cache-level events
 * such as queries being added/removed and query state being updated.
 *
 * QueryCache implements QueryCacheInterface (from query.ts) so that individual
 * Query instances can call back into the cache (notify, remove) without the
 * file needing to import QueryCache — breaking the potential circular dependency.
 *
 * Usage:
 *   const cache = new QueryCache({ onError: (err, query) => console.error(err) })
 *   const query = cache.build(client, { queryKey: ['users'] })
 *   const unsubscribe = cache.subscribe((event) => console.log(event.type))
 */
export class QueryCache
  extends Subscribable<QueryCacheListener>
  implements QueryCacheInterface
{
  /**
   * The Map that backs all cache storage. QueryHash is the serialized string
   * representation of a query key produced by hashQueryKey().
   *
   * Private field syntax (`#`) prevents any external mutation — the only way
   * to write to this Map is through build() and remove().
   */
  #queries: Map<QueryHash, Query>

  constructor(public config: QueryCacheConfig = {}) {
    super()
    this.#queries = new Map()
  }

  // -------------------------------------------------------------------------
  // Factory — the ONLY place Query instances are created
  // -------------------------------------------------------------------------

  /**
   * Find an existing Query by key, or create and register a new one.
   *
   * This is the single point of Query creation. All query consumers (QueryClient,
   * QueryObserver) must call `cache.build()` rather than `new Query()` directly.
   *
   * Steps:
   *  1. Derive the hash from options.queryKeyHashFn (custom) or hashQueryKey (default).
   *  2. Look up an existing Query in #queries by that hash.
   *  3. If found, return it (deduplication — multiple observers share one Query).
   *  4. If not found, create a new Query with merged default options, store it,
   *     and fire an 'added' event so subscribers know a new key is being tracked.
   *
   * @param client  - Used to apply default query options before construction.
   * @param options - Query options including the required queryKey.
   * @returns The existing or newly created Query instance.
   */
  build<
    TData = unknown,
    TError = Error,
    TQueryKey extends QueryKey = QueryKey,
  >(
    client: QueryClientInterface,
    options: QueryOptions<TData, TError, TQueryKey>,
  ): Query<TData, TError, TQueryKey> {
    const queryKey = options.queryKey

    // Prefer a custom hash function (e.g. to ignore certain key segments)
    // over the global default. This allows per-query hashing strategies.
    const queryHash = options.queryKeyHashFn
      ? options.queryKeyHashFn(queryKey)
      : hashQueryKey(queryKey)

    // Cast is safe: we only store Query<TData, TError, TQueryKey> under this
    // hash, and on a cache miss we create exactly that type below.
    let query = this.#queries.get(queryHash) as
      | Query<TData, TError, TQueryKey>
      | undefined

    if (!query) {
      // Apply the client's default options (staleTime, gcTime, retry, etc.)
      // before constructing the Query so the entry starts with correct defaults.
      query = new Query<TData, TError, TQueryKey>({
        cache: this,
        queryKey,
        queryHash,
        options: client.defaultQueryOptions(options),
      })

      this.#queries.set(queryHash, query as unknown as Query)

      // Broadcast the addition. The cast to `Query` (base form) is the same
      // pattern used throughout query.ts: `this as unknown as Query`.
      this.notify({ type: 'added', query: query as unknown as Query })
    }

    return query
  }

  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------

  /**
   * Remove a query from the cache and destroy it.
   *
   * Called in two scenarios:
   *  1. By Query.optionalRemove() after the GC timer fires (deferred removal).
   *  2. By QueryCache.clear() for an immediate full reset.
   *
   * Implements QueryCacheInterface.remove() so that Query can trigger its own
   * removal without importing this file.
   *
   * The guard (`if (cachedQuery)`) ensures the operation is idempotent — calling
   * remove() on a query that has already been evicted is a safe no-op.
   *
   * @param query - The query to evict and destroy.
   */
  remove(query: Query): void {
    const cachedQuery = this.#queries.get(query.queryHash)
    if (cachedQuery) {
      // destroy() cancels any in-flight fetch and clears the GC timer.
      query.destroy()
      this.#queries.delete(query.queryHash)
      this.notify({ type: 'removed', query })
    }
  }

  // -------------------------------------------------------------------------
  // Bulk removal
  // -------------------------------------------------------------------------

  /**
   * Destroy all queries and clear the cache.
   *
   * Useful for:
   * - Logging out a user (evict all server state)
   * - Resetting the client in tests between test cases
   *
   * Each query is destroyed individually (cancels fetch + GC timer) before
   * the map is cleared, so no pending timers leak after this call.
   */
  clear(): void {
    this.#queries.forEach((query) => query.destroy())
    this.#queries.clear()
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /**
   * Synchronous O(1) lookup by pre-computed hash.
   *
   * Prefer this over find() when you already have the hash (e.g. inside
   * QueryObserver which always knows its query's hash).
   *
   * @param queryHash - The serialized key hash to look up.
   * @returns The matching Query, or undefined if not in cache.
   */
  get<
    TData = unknown,
    TError = Error,
    TQueryKey extends QueryKey = QueryKey,
  >(
    queryHash: QueryHash,
  ): Query<TData, TError, TQueryKey> | undefined {
    return this.#queries.get(queryHash) as
      | Query<TData, TError, TQueryKey>
      | undefined
  }

  /**
   * Return every Query currently registered in the cache as a flat array.
   *
   * The array is a snapshot — mutations to the cache after this call are not
   * reflected in the returned array. Used internally by find() / findAll() and
   * by QueryClient operations that iterate over all queries.
   */
  getAll(): Query[] {
    return [...this.#queries.values()]
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  /**
   * Find the first Query matching the given filters.
   *
   * @param filters - Criteria to match against. See QueryFilters in types.ts.
   * @returns The first matching Query, or undefined if none match.
   */
  find<TData = unknown, TError = Error>(
    filters: QueryFilters,
  ): Query<TData, TError> | undefined {
    const { exact, queryKey, ...rest } = filters
    return this.getAll().find((query) =>
      matchesQuery(query, { exact, queryKey, ...rest }),
    ) as Query<TData, TError> | undefined
  }

  /**
   * Find all Queries matching the given filters.
   *
   * An empty filters object returns every query in the cache (equivalent to
   * getAll() but with the same call signature for consistency).
   *
   * Used by QueryClient.invalidateQueries, removeQueries, refetchQueries, etc.
   *
   * @param filters - Criteria to match against. Defaults to {} (match all).
   * @returns Array of matching Query instances.
   */
  findAll(filters: QueryFilters = {}): Query[] {
    const queries = this.getAll()
    if (Object.keys(filters).length === 0) return queries
    return queries.filter((query) => matchesQuery(query, filters))
  }

  // -------------------------------------------------------------------------
  // Notification — implements QueryCacheInterface
  // -------------------------------------------------------------------------

  /**
   * Dispatch a cache-level event to all subscribers.
   *
   * Implements QueryCacheInterface.notify() so individual Query instances can
   * trigger cache notifications (e.g. 'updated', 'observerAdded') without
   * importing this class.
   *
   * All notifications are wrapped in notifyManager.batch() to prevent render
   * cascades: if ten queries are invalidated synchronously, their observers
   * accumulate in the batch queue and flush together in a single scheduler tick,
   * producing one React render rather than ten.
   *
   * @param event - The strongly-typed cache event to broadcast.
   */
  notify(event: QueryCacheNotifyEvent): void {
    notifyManager.batch(() => {
      this.listeners.forEach((listener) => listener(event))
    })
  }

  // -------------------------------------------------------------------------
  // Browser event bridges
  // -------------------------------------------------------------------------

  /**
   * Called by FocusManager when the browser window regains focus.
   *
   * Iterates over every query and forwards the focus event to each attached
   * observer. Individual observers decide whether to refetch based on their
   * `refetchOnWindowFocus` option — this method is intentionally policy-free.
   *
   * The duck-typed cast `(observer as { onFocus?: () => void })` is required
   * because QueryObserver is not yet imported here (it imports QueryCache,
   * which would create a circular dependency). The interface check ensures
   * we only call onFocus() when the method actually exists.
   */
  onFocus(): void {
    this.#queries.forEach((query) => {
      query.observers.forEach((observer) => {
        if (typeof (observer as { onFocus?: () => void }).onFocus === 'function') {
          ;(observer as unknown as { onFocus: () => void }).onFocus()
        }
      })
    })
  }

  /**
   * Called by OnlineManager when the network reconnects.
   *
   * Forwards the online event to every Query so that fetches paused while
   * offline (fetchStatus === 'paused') can be automatically resumed without
   * the user having to trigger a manual refetch.
   *
   * See Query.onOnline() for the per-query implementation.
   */
  onOnline(): void {
    this.#queries.forEach((query) => {
      query.onOnline()
    })
  }
}
