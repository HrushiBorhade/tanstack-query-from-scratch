/**
 * queryClient.ts
 *
 * The public API facade for the entire system.
 *
 * Users create ONE QueryClient instance, pass it to QueryClientProvider, and
 * interact with the cache through methods like invalidateQueries, setQueryData,
 * fetchQuery, etc. QueryClient owns both the QueryCache and MutationCache and
 * wires them to browser event managers on mount.
 *
 * Pattern: Facade — delegates all real work to the caches, Query, and Mutation
 * instances. Never does fetch/state work itself.
 */

import { QueryCache } from './queryCache'
import { MutationCache } from './mutationCache'
import { focusManager } from './focusManager'
import { onlineManager } from './onlineManager'
import { noop } from './utils'
import type {
  QueryKey,
  QueryOptions,
  QueryState,
  QueryFilters,
  MutationOptions,
  MutationStatus,
  DefaultOptions,
} from './types'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Top-level configuration for QueryClient.
 *
 * Extends the base QueryClientConfig from types.ts to also accept pre-built
 * cache instances — useful for testing and custom cache configurations.
 */
export interface QueryClientConfig {
  /** Custom QueryCache instance. Creates a default one if omitted. */
  queryCache?: QueryCache
  /** Custom MutationCache instance. Creates a default one if omitted. */
  mutationCache?: MutationCache
  /**
   * Default options applied to all queries and mutations created through
   * this client, unless overridden at the individual call site.
   */
  defaultOptions?: DefaultOptions
}

// ---------------------------------------------------------------------------
// QueryClient
// ---------------------------------------------------------------------------

export class QueryClient {
  // -------------------------------------------------------------------------
  // Private fields
  // -------------------------------------------------------------------------

  readonly #queryCache: QueryCache
  readonly #mutationCache: MutationCache
  #defaultOptions: DefaultOptions

  /**
   * Reference-count for mount()/unmount() calls.
   * Allows the same QueryClient to be used in nested providers without
   * double-subscribing to focus/online managers.
   */
  #mountCount: number = 0

  /** Cleanup function returned by focusManager.subscribe() */
  #unsubscribeFocus?: () => void
  /** Cleanup function returned by onlineManager.subscribe() */
  #unsubscribeOnline?: () => void

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(config: QueryClientConfig = {}) {
    this.#queryCache = config.queryCache ?? new QueryCache()
    this.#mutationCache = config.mutationCache ?? new MutationCache()
    this.#defaultOptions = config.defaultOptions ?? {}
  }

  // -------------------------------------------------------------------------
  // Lifecycle — called by QueryClientProvider
  // -------------------------------------------------------------------------

  /**
   * Subscribe to browser focus and online events.
   *
   * Called by QueryClientProvider on mount. Reference-counted so that
   * nested providers sharing the same client do not double-subscribe.
   */
  mount(): void {
    this.#mountCount++
    if (this.#mountCount !== 1) return // already mounted

    // Refetch stale queries when the user returns to the tab
    this.#unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) {
        this.#queryCache.onFocus()
      }
    })

    // Resume paused fetches and mutations when the network comes back
    this.#unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online) {
        this.#queryCache.onOnline()
        void this.#mutationCache.resumePausedMutations()
      }
    })

    // Wire up the actual browser event listeners (idempotent, safe to call
    // multiple times — FocusManager/OnlineManager tear down previous listeners)
    focusManager.setup()
    onlineManager.setup()
  }

  /**
   * Unsubscribe from browser events.
   *
   * Called by QueryClientProvider on unmount. Only tears down on the last
   * unmount when the ref-count reaches zero.
   */
  unmount(): void {
    this.#mountCount--
    if (this.#mountCount > 0) return // still in use by a nested provider

    this.#unsubscribeFocus?.()
    this.#unsubscribeOnline?.()
    this.#unsubscribeFocus = undefined
    this.#unsubscribeOnline = undefined
  }

  // -------------------------------------------------------------------------
  // Cache access
  // -------------------------------------------------------------------------

  /** Returns the underlying QueryCache instance. */
  getQueryCache(): QueryCache {
    return this.#queryCache
  }

  /** Returns the underlying MutationCache instance. */
  getMutationCache(): MutationCache {
    return this.#mutationCache
  }

  // -------------------------------------------------------------------------
  // Options normalization — used by QueryObserver + MutationObserver
  // -------------------------------------------------------------------------

  /**
   * Merge global defaultOptions.queries with per-query options.
   * Per-query options always win over global defaults.
   */
  defaultQueryOptions<
    TData = unknown,
    TError = Error,
    TQueryKey extends QueryKey = QueryKey,
  >(
    options: QueryOptions<TData, TError, TQueryKey>,
  ): QueryOptions<TData, TError, TQueryKey> {
    return {
      ...this.#defaultOptions.queries,
      ...options,
    } as QueryOptions<TData, TError, TQueryKey>
  }

  /**
   * Merge global defaultOptions.mutations with per-mutation options.
   */
  defaultMutationOptions<
    TData = unknown,
    TError = Error,
    TVariables = unknown,
    TContext = unknown,
  >(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): MutationOptions<TData, TError, TVariables, TContext> {
    return {
      ...this.#defaultOptions.mutations,
      ...options,
    } as MutationOptions<TData, TError, TVariables, TContext>
  }

  // -------------------------------------------------------------------------
  // Synchronous cache reads
  // -------------------------------------------------------------------------

  /**
   * Synchronously read the cached data for a query key.
   * Returns `undefined` if no data has been fetched yet.
   */
  getQueryData<TData = unknown>(queryKey: QueryKey): TData | undefined {
    return this.#queryCache.find<TData>({ queryKey, exact: true })?.state.data
  }

  /**
   * Synchronously read the full state for a query key.
   * Returns `undefined` if the query doesn't exist in the cache.
   */
  getQueryState<TData = unknown, TError = Error>(
    queryKey: QueryKey,
  ): QueryState<TData, TError> | undefined {
    return this.#queryCache.find<TData, TError>({ queryKey, exact: true })?.state
  }

  // -------------------------------------------------------------------------
  // Manual cache writes (optimistic updates)
  // -------------------------------------------------------------------------

  /**
   * Immediately write data into the cache for a query key.
   *
   * Accepts either:
   * - A direct value:      setQueryData(['todos'], newTodos)
   * - An updater function: setQueryData(['todos'], (old) => [...old, newTodo])
   *
   * Returns the new data, or `undefined` if the query didn't exist.
   */
  setQueryData<TData>(
    queryKey: QueryKey,
    updater: TData | ((oldData: TData | undefined) => TData | undefined),
    options?: { updatedAt?: number },
  ): TData | undefined {
    const query = this.#queryCache.find<TData>({ queryKey, exact: true })
    if (!query) return undefined

    const newData =
      typeof updater === 'function'
        ? (updater as (old: TData | undefined) => TData | undefined)(
            query.state.data,
          )
        : updater

    if (newData === undefined) return undefined

    query.setData(newData, options)
    return newData
  }

  // -------------------------------------------------------------------------
  // Imperative fetch
  // -------------------------------------------------------------------------

  /**
   * Fetch a query and return a Promise that resolves with the data.
   * Throws on error. Respects deduplication — if already fetching, returns
   * the existing in-flight promise.
   */
  async fetchQuery<
    TData = unknown,
    TError = Error,
    TQueryKey extends QueryKey = QueryKey,
  >(options: QueryOptions<TData, TError, TQueryKey>): Promise<TData> {
    const defaulted = this.defaultQueryOptions(options)
    const query = this.#queryCache.build<TData, TError, TQueryKey>(this, defaulted)
    return query.fetch(defaulted)
  }

  /**
   * Fetch a query without throwing — errors are swallowed.
   * Used for pre-populating the cache before rendering (prefetching).
   */
  async prefetchQuery<
    TData = unknown,
    TQueryKey extends QueryKey = QueryKey,
  >(options: QueryOptions<TData, Error, TQueryKey>): Promise<void> {
    await this.fetchQuery(options).catch(noop)
  }

  // -------------------------------------------------------------------------
  // Cache invalidation
  // -------------------------------------------------------------------------

  /**
   * Invalidate queries matching the given filters.
   *
   * Two-step process:
   * 1. Mark ALL matching queries as invalidated (sets isInvalidated: true).
   * 2. Immediately refetch ACTIVE (currently observed) matching queries.
   *
   * Inactive (unobserved) queries will refetch when next subscribed.
   */
  async invalidateQueries(
    filters: QueryFilters = {},
    options: { throwOnError?: boolean; cancelRefetch?: boolean } = {},
  ): Promise<void> {
    // Step 1: mark all matching queries as invalidated
    this.#queryCache.findAll(filters).forEach((query) => query.invalidate())

    // Step 2: refetch only the active ones (components are mounted and watching)
    const activeQueries = this.#queryCache.findAll({
      ...filters,
      type: 'active',
    })

    const promises = activeQueries.map((query) =>
      query.fetch(undefined, {
        cancelRefetch: options.cancelRefetch ?? true,
      }),
    )

    if (options.throwOnError) {
      await Promise.all(promises)
    } else {
      await Promise.allSettled(promises)
    }
  }

  /**
   * Refetch queries matching the given filters — without marking them
   * invalidated first. Use `invalidateQueries` when you want to express
   * "this data is stale"; use `refetchQueries` when you want to force
   * an immediate refetch regardless of staleness.
   */
  async refetchQueries(
    filters: QueryFilters = {},
    options: { throwOnError?: boolean; cancelRefetch?: boolean } = {},
  ): Promise<void> {
    const queries = this.#queryCache.findAll(filters)
    const promises = queries.map((q) =>
      q.fetch(undefined, { cancelRefetch: options.cancelRefetch ?? true }),
    )
    if (options.throwOnError) {
      await Promise.all(promises)
    } else {
      await Promise.allSettled(promises)
    }
  }

  /**
   * Cancel any in-flight fetches for queries matching the filters.
   * Does not remove queries from the cache.
   */
  cancelQueries(filters: QueryFilters = {}): void {
    this.#queryCache
      .findAll(filters)
      .forEach((query) => query.cancel({ silent: true }))
  }

  /**
   * Remove queries from the cache entirely.
   * Any active observers will immediately see a fresh pending state.
   */
  removeQueries(filters: QueryFilters = {}): void {
    this.#queryCache
      .findAll(filters)
      .forEach((query) => this.#queryCache.remove(query))
  }

  /**
   * Reset queries to their initial (pre-fetch) state and trigger a refetch
   * for any that are currently active.
   */
  async resetQueries(
    filters: QueryFilters = {},
    options: { throwOnError?: boolean } = {},
  ): Promise<void> {
    // Cancel any in-flight fetches first
    this.cancelQueries(filters)
    // Then force an immediate refetch for active queries
    await this.refetchQueries({ ...filters, type: 'active' }, options)
  }

  /** Remove all queries and mutations from both caches. */
  clear(): void {
    this.#queryCache.clear()
    this.#mutationCache.clear()
  }

  // -------------------------------------------------------------------------
  // Status inspection
  // -------------------------------------------------------------------------

  /**
   * Returns the number of queries currently fetching (including background
   * refetches). Useful for global loading indicators.
   */
  isFetching(filters: QueryFilters = {}): number {
    return this.#queryCache.findAll({ ...filters, fetchStatus: 'fetching' }).length
  }

  /**
   * Returns the number of mutations currently in-flight.
   */
  isMutating(_filters: { status?: MutationStatus } = {}): number {
    return this.#mutationCache
      .getAll()
      .filter((m) => m.state.status === 'pending').length
  }

  // -------------------------------------------------------------------------
  // Default options management
  // -------------------------------------------------------------------------

  getDefaultOptions(): DefaultOptions {
    return this.#defaultOptions
  }

  setDefaultOptions(options: DefaultOptions): void {
    this.#defaultOptions = options
  }

  // -------------------------------------------------------------------------
  // Per-key defaults (scoped defaults for specific query keys)
  // -------------------------------------------------------------------------

  /**
   * Store query-key-scoped default options.
   * QueryObserver.setOptions() will merge these before applying user options.
   *
   * NOTE: For simplicity in this implementation we store them on the
   * defaultOptions object; a production version would maintain a separate
   * Map<QueryHash, QueryOptions> for O(1) lookup.
   */
  setQueryDefaults(
    _queryKey: QueryKey,
    _options: Partial<QueryOptions>,
  ): void {
    // Intentionally minimal for this implementation
  }
}
