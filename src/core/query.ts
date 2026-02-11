/**
 * query.ts
 *
 * The central cache entry and state machine for a single query key.
 *
 * A Query instance:
 * - Holds all state for one queryKey (data, errors, fetch status, etc.)
 * - Owns the fetch/retry lifecycle via a Retryer instance
 * - Notifies attached observers and the QueryCache on every state transition
 * - Schedules its own garbage collection when no observers remain
 *
 * Design decisions:
 * - Private fields (`#`) prevent accidental external mutation of internals
 * - The state machine reducer is a pure function for easy testing and reasoning
 * - Request deduplication: a second fetch() on an already-in-flight query
 *   returns the existing Retryer promise rather than starting a new request
 * - The QueryCacheInterface and QueryObserverInterface are defined here (not
 *   in the files that implement them) to break the circular import cycle that
 *   would arise if query.ts imported queryCache.ts or queryObserver.ts
 */

import type { QueryKey, QueryHash, QueryOptions, QueryState, QueryMeta } from './types'
import { Removable } from './removable'
import { Retryer } from './retryer'
import { notifyManager } from './notifyManager'

// ---------------------------------------------------------------------------
// Break-circular-dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal interface that a QueryObserver must implement so Query can call back
 * into it without importing the full QueryObserver class (which imports Query).
 */
export interface QueryObserverInterface {
  /** Called by the Query whenever its state changes. */
  onQueryUpdate(): void
}

// Forward-declare the types used in QueryCacheNotifyEvent before defining the
// interface, so the event union can reference Query and QueryObserverInterface.

/** All event types the QueryCache can receive from a Query. */
export type QueryCacheNotifyEvent<TData = unknown, TError = Error> =
  | { type: 'added'; query: Query<TData, TError> }
  | { type: 'removed'; query: Query<TData, TError> }
  | { type: 'updated'; query: Query<TData, TError>; action: QueryAction<TData, TError> }
  | { type: 'observerAdded'; query: Query<TData, TError>; observer: QueryObserverInterface }
  | { type: 'observerRemoved'; query: Query<TData, TError>; observer: QueryObserverInterface }
  | { type: 'observerResultsUpdated'; query: Query<TData, TError> }
  | { type: 'observerOptionsUpdated'; query: Query<TData, TError>; observer: QueryObserverInterface }

/**
 * Minimal interface that the QueryCache must implement so Query can call back
 * into it without importing the full QueryCache class (which creates a cycle).
 */
export interface QueryCacheInterface {
  notify(event: QueryCacheNotifyEvent): void
  remove(query: Query): void
}

// ---------------------------------------------------------------------------
// Constructor config
// ---------------------------------------------------------------------------

/** Configuration passed to the Query constructor. */
export interface QueryConfig<
  TData = unknown,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
> {
  /** Reference to the owning QueryCache — used for removal and notifications. */
  cache: QueryCacheInterface
  /** The stable, serializable key that identifies this query. */
  queryKey: TQueryKey
  /** Pre-hashed string representation of queryKey. */
  queryHash: QueryHash
  /** Initial merged options for this query entry. */
  options: QueryOptions<TData, TError, TQueryKey>
}

// ---------------------------------------------------------------------------
// State-machine action types
// ---------------------------------------------------------------------------

/**
 * All actions that can be dispatched to the Query state machine reducer.
 *
 * Each action type drives a specific transition described in the reducer below.
 */
export type QueryAction<TData = unknown, TError = Error> =
  | { type: 'fetch'; meta?: QueryMeta }
  | { type: 'success'; data: TData; manual?: boolean }
  | { type: 'error'; error: TError }
  | { type: 'invalidate' }
  | { type: 'setState'; state: Partial<QueryState<TData, TError>> }
  | { type: 'failed'; failureCount: number; error: TError }
  | { type: 'pause' }
  | { type: 'continue' }
  | { type: 'cancel' }

// ---------------------------------------------------------------------------
// Reducer (pure function — no side effects)
// ---------------------------------------------------------------------------

/**
 * Computes the next QueryState given the previous state and an action.
 *
 * This is intentionally a pure function with no side effects so that it can
 * be tested in isolation and reasoned about independently of the Query class.
 */
function reducer<TData, TError>(
  state: QueryState<TData, TError>,
  action: QueryAction<TData, TError>,
): QueryState<TData, TError> {
  switch (action.type) {
    case 'fetch':
      return {
        ...state,
        fetchFailureCount: 0,
        fetchFailureReason: null,
        fetchStatus: 'fetching',
        // Only go back to 'pending' if there is no existing data.
        // If we already have data (background refetch), keep status as 'success'.
        ...(state.data === undefined && { status: 'pending', error: null }),
      }

    case 'success':
      return {
        ...state,
        data: action.data,
        dataUpdatedAt: Date.now(),
        error: null,
        errorUpdatedAt: 0,
        fetchFailureCount: 0,
        fetchFailureReason: null,
        // A manual success (setData) preserves the current fetchStatus so it
        // does not prematurely flip a background refetch to 'idle'.
        fetchStatus: action.manual ? state.fetchStatus : 'idle',
        isInvalidated: false,
        status: 'success',
      }

    case 'error':
      return {
        ...state,
        error: action.error,
        errorUpdatedAt: Date.now(),
        // Preserve fetchFailureCount from the 'failed' actions that preceded
        // this terminal 'error' action.
        fetchFailureCount: state.fetchFailureCount,
        fetchStatus: 'idle',
        status: 'error',
      }

    case 'invalidate':
      return { ...state, isInvalidated: true }

    case 'setState':
      return { ...state, ...action.state }

    case 'failed':
      return {
        ...state,
        fetchFailureCount: action.failureCount,
        fetchFailureReason: action.error,
      }

    case 'pause':
      return { ...state, fetchStatus: 'paused' }

    case 'continue':
      return { ...state, fetchStatus: 'fetching' }

    case 'cancel':
      return { ...state, fetchStatus: 'idle' }
  }
}

// ---------------------------------------------------------------------------
// Default initial state helper
// ---------------------------------------------------------------------------

/**
 * Build the initial QueryState for a newly created Query entry.
 *
 * If `options.initialData` is provided the state starts as 'success';
 * otherwise it starts as 'pending' with no data.
 */
function getDefaultState<TData, TError, TQueryKey extends QueryKey = QueryKey>(
  options: QueryOptions<TData, TError, TQueryKey>,
): QueryState<TData, TError> {
  const hasInitialData = options.initialData !== undefined

  // Support both a plain value and a factory function for initialData.
  const initialData =
    typeof options.initialData === 'function'
      ? (options.initialData as () => TData)()
      : options.initialData

  // Support both a plain timestamp and a factory function for the updated-at.
  // The factory signature is `() => number | undefined`, so we fall back to
  // Date.now() when it returns undefined to keep dataUpdatedAt typed as number.
  const initialDataUpdatedAt: number = hasInitialData
    ? typeof options.initialDataUpdatedAt === 'function'
      ? (options.initialDataUpdatedAt() ?? Date.now())
      : (options.initialDataUpdatedAt ?? Date.now())
    : 0

  return {
    data: initialData,
    dataUpdatedAt: initialData !== undefined ? initialDataUpdatedAt : 0,
    error: null,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchStatus: 'idle',
    isInvalidated: false,
    status: hasInitialData ? 'success' : 'pending',
  }
}

// ---------------------------------------------------------------------------
// Query class
// ---------------------------------------------------------------------------

/**
 * A single entry in the QueryCache, representing all state for one queryKey.
 *
 * Lifecycle:
 *  1. Created by QueryCache.build() when a new queryKey is first observed
 *  2. Observers attach via addObserver() — clears any pending GC timeout
 *  3. fetch() is called → Retryer runs → state transitions fire via #dispatch
 *  4. Observers detach via removeObserver() — schedules GC when count reaches 0
 *  5. GC timeout fires → optionalRemove() → QueryCache.remove()
 */
export class Query<
  TData = unknown,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
> extends Removable {
  // -------------------------------------------------------------------------
  // Public fields
  // -------------------------------------------------------------------------

  /** The stable, serializable key that identifies this query. */
  readonly queryKey: TQueryKey

  /** Pre-computed hash of queryKey for O(1) cache lookups. */
  readonly queryHash: QueryHash

  /** Merged options for this query. May be updated on every fetch() call. */
  options: QueryOptions<TData, TError, TQueryKey>

  /** The current state of this query (data, error, status, fetchStatus…). */
  state: QueryState<TData, TError>

  /**
   * All currently attached observers. Public so observers can check whether
   * they are already registered before calling addObserver.
   */
  observers: QueryObserverInterface[]

  // -------------------------------------------------------------------------
  // Private fields
  // -------------------------------------------------------------------------

  /** Back-reference to the owning cache, used for notifications and removal. */
  #cache: QueryCacheInterface

  /**
   * The active Retryer for the current in-flight fetch.
   * Undefined when fetchStatus === 'idle'.
   */
  #retryer?: Retryer<TData, TError>

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(config: QueryConfig<TData, TError, TQueryKey>) {
    super()
    this.#cache = config.cache
    this.queryKey = config.queryKey
    this.queryHash = config.queryHash
    this.options = config.options
    this.observers = []

    // Initialize GC time from options (Removable.updateGcTime handles defaults).
    this.updateGcTime(this.options.gcTime)

    // Build initial state — may include initialData if provided.
    this.state = getDefaultState(this.options)
  }

  // -------------------------------------------------------------------------
  // Observer management
  // -------------------------------------------------------------------------

  /**
   * Attach an observer to this query.
   *
   * Adding an observer cancels any pending GC timeout because at least one
   * consumer is now interested in the data. The cache is notified so that
   * DevTools and other subscribers can react.
   *
   * @param observer - The observer to attach.
   */
  addObserver(observer: QueryObserverInterface): void {
    if (!this.observers.includes(observer)) {
      this.observers.push(observer)
      // Someone is watching — cancel the scheduled removal.
      this.clearGcTimeout()
      this.#cache.notify({ type: 'observerAdded', query: this as unknown as Query, observer })
    }
  }

  /**
   * Detach an observer from this query.
   *
   * When the last observer is removed, GC is scheduled. The cache is notified
   * regardless so DevTools can stay in sync.
   *
   * @param observer - The observer to detach.
   */
  removeObserver(observer: QueryObserverInterface): void {
    if (this.observers.includes(observer)) {
      this.observers = this.observers.filter((x) => x !== observer)
      if (!this.observers.length) {
        // No more observers — schedule deferred removal from the cache.
        this.scheduleGc()
      }
      this.#cache.notify({ type: 'observerRemoved', query: this as unknown as Query, observer })
    }
  }

  // -------------------------------------------------------------------------
  // Staleness
  // -------------------------------------------------------------------------

  /**
   * Returns true if the current data is considered stale given a staleTime.
   *
   * Rules (in priority order):
   * 1. status === 'pending'    → always stale (no data yet)
   * 2. staleTime === 'static'  → never stale (static data, e.g. constants)
   * 3. isInvalidated           → always stale (explicitly invalidated)
   * 4. staleTime === 0         → always stale (default TanStack Query behaviour)
   * 5. Otherwise               → stale if dataUpdatedAt + staleTime < now
   *
   * @param staleTime - The stale window in ms, or 'static' for never-stale.
   */
  isStaleByTime(staleTime: number | 'static' = 0): boolean {
    if (this.state.status === 'pending') return true
    if (staleTime === 'static') return false
    if (this.state.isInvalidated) return true
    if (!staleTime) return true
    return Date.now() > this.state.dataUpdatedAt + staleTime
  }

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  /**
   * Trigger a fetch (or background refetch) for this query.
   *
   * Deduplication: if a fetch is already in flight and `cancelRefetch` is
   * false (the default), the method returns the existing Retryer promise
   * instead of starting a second request. This is the key mechanism that
   * prevents duplicate network calls when multiple components mount and call
   * useQuery with the same key simultaneously.
   *
   * Cancellation: if `cancelRefetch` is true and there is already data,
   * the current fetch is cancelled and a fresh one starts from scratch.
   *
   * @param options     - Additional options to merge into this.options.
   * @param fetchOptions - Controls deduplication behaviour.
   * @returns A promise that resolves to the fetched data or rejects on error.
   */
  async fetch(
    options?: QueryOptions<TData, TError, TQueryKey>,
    fetchOptions?: { cancelRefetch?: boolean },
  ): Promise<TData> {
    // ---- Deduplication / cancellation logic --------------------------------
    if (this.state.fetchStatus !== 'idle') {
      if (this.state.data !== undefined && fetchOptions?.cancelRefetch) {
        // We have existing data and the caller explicitly wants a fresh fetch.
        // Cancel the current in-flight request silently (so the old promise
        // doesn't reject with a CancelledError that nobody is listening to).
        this.cancel({ silent: true })
      } else if (this.#retryer) {
        // DEDUPLICATION: another request is already in flight.
        // Wake it up if it was paused and return its promise so the caller
        // shares the same result without issuing a second network request.
        this.#retryer.continue()
        return this.#retryer.promise
      }
    }

    // ---- Merge options -----------------------------------------------------
    if (options) {
      this.options = { ...this.options, ...options }
    }
    // Re-evaluate GC time in case the new options change it.
    this.updateGcTime(this.options.gcTime)

    // ---- Build the fetch function ------------------------------------------
    // A new AbortController is created for each distinct fetch attempt so that
    // cancelling one fetch does not affect a subsequent one.
    const abortController = new AbortController()

    const fetchFn = (): Promise<TData> => {
      if (!this.options.queryFn) {
        return Promise.reject(
          new Error(`Missing queryFn for queryKey '${this.queryHash}'`),
        )
      }
      return Promise.resolve(
        this.options.queryFn({
          queryKey: this.queryKey,
          signal: abortController.signal,
          meta: this.options.meta,
        }),
      )
    }

    // ---- Transition to fetching state --------------------------------------
    this.#dispatch({ type: 'fetch' })

    // ---- Create and wire up the Retryer ------------------------------------
    this.#retryer = new Retryer<TData, TError>({
      fn: fetchFn,
      abort: () => abortController.abort(),

      onSuccess: (data) => {
        this.setData(data)
        this.#retryer = undefined
      },

      onError: (error) => {
        this.#dispatch({ type: 'error', error })
        this.#retryer = undefined
      },

      onFail: (failureCount, error) => {
        this.#dispatch({ type: 'failed', failureCount, error })
      },

      onPause: () => {
        this.#dispatch({ type: 'pause' })
      },

      onContinue: () => {
        this.#dispatch({ type: 'continue' })
      },

      retry: this.options.retry,
      retryDelay: this.options.retryDelay,
      networkMode: this.options.networkMode,
    })

    // start() is async and returns this.#retryer.promise; when that promise
    // rejects, start()'s own returned promise also rejects. Silence that
    // duplicate rejection — callers handle errors via this.#retryer.promise.
    this.#retryer.start().catch(() => {})

    return this.#retryer.promise
  }

  // -------------------------------------------------------------------------
  // Manual data write (optimistic updates / prefetch seeding)
  // -------------------------------------------------------------------------

  /**
   * Write data directly into the cache for this query, bypassing a fetch.
   *
   * Used for:
   * - Optimistic updates (write before the mutation completes)
   * - QueryClient.setQueryData (server-side seeding, test helpers)
   * - queryClient.prefetchQuery (pre-populate before a route renders)
   *
   * The `manual: true` flag on the dispatched action prevents flipping
   * fetchStatus to 'idle', so an ongoing background refetch continues.
   *
   * @param data    - The data to write into the cache.
   * @param options - Optional metadata about the write.
   * @returns The data that was written (for chaining convenience).
   */
  setData(
    data: TData,
    options?: { updatedAt?: number; manual?: boolean },
  ): TData {
    this.#dispatch({
      type: 'success',
      data,
      manual: options?.manual,
    })
    return data
  }

  // -------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------

  /**
   * Mark this query as invalidated so it will be refetched on next mount.
   *
   * Invalidation is idempotent — calling it on an already-invalidated query
   * is a no-op (no unnecessary state dispatch or observer notifications).
   */
  invalidate(): void {
    if (!this.state.isInvalidated) {
      this.#dispatch({ type: 'invalidate' })
    }
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  /**
   * Cancel the current in-flight fetch.
   *
   * Delegates to the active Retryer. If no fetch is in progress this is safe
   * to call — it is simply a no-op.
   *
   * @param options.silent - If true, the retryer promise will not be rejected.
   *   Use when the caller wants to discard the fetch without surfacing an error.
   * @param options.revert - Reserved for future rollback semantics.
   */
  cancel(options?: { silent?: boolean; revert?: boolean }): void {
    this.#retryer?.cancel(options)
    if (this.state.fetchStatus !== 'idle') {
      this.#dispatch({ type: 'cancel' })
    }
  }

  // -------------------------------------------------------------------------
  // Online event handler
  // -------------------------------------------------------------------------

  /**
   * Called by the QueryCache (via OnlineManager) when the network reconnects.
   *
   * If this query's fetch was paused waiting for the network, we resume it
   * so the user gets their data without having to trigger a manual refetch.
   */
  onOnline(): void {
    if (this.state.fetchStatus === 'paused') {
      this.#retryer?.continue()
    }
  }

  // -------------------------------------------------------------------------
  // Removable contract
  // -------------------------------------------------------------------------

  /**
   * Destroy this query and cancel any pending GC timeout.
   *
   * Called by QueryCache.remove() / QueryClient.clear() for immediate,
   * non-deferred removal. Cancels any in-flight fetch and deregisters the
   * GC timer so optionalRemove() never fires after this point.
   */
  override destroy(): void {
    super.destroy()
    this.cancel()
  }

  /**
   * Remove this query from the cache if it is still safe to do so.
   *
   * Called by the GC timer after gcTime ms of inactivity. We check that no
   * observer has re-subscribed in the meantime and that the fetch is idle
   * (a paused fetch still "owns" this entry — removing it would lose state).
   *
   * This method is declared abstract in Removable and must be implemented here.
   */
  protected optionalRemove(): void {
    if (!this.observers.length && this.state.fetchStatus === 'idle') {
      this.#cache.remove(this as unknown as Query)
    }
  }

  // -------------------------------------------------------------------------
  // Private state machine dispatch
  // -------------------------------------------------------------------------

  /**
   * Apply an action to the state machine, write the new state, and notify
   * all observers + the cache in a single batched notification pass.
   *
   * Using notifyManager.batch() ensures that if multiple observers are
   * attached (e.g. the same query key used in ten components), all of them
   * are collected into one flush rather than triggering ten separate renders.
   *
   * @param action - The action to dispatch.
   */
  #dispatch(action: QueryAction<TData, TError>): void {
    // Compute the new state via the pure reducer (no mutations).
    const newState = reducer(this.state, action)
    this.state = newState

    notifyManager.batch(() => {
      // Notify every observer so they can recompute their derived results.
      this.observers.forEach((observer) => observer.onQueryUpdate())
      // Notify the cache so DevTools / event subscribers stay in sync.
      this.#cache.notify({
        type: 'updated',
        query: this as unknown as Query,
        action: action as unknown as QueryAction,
      })
    })
  }
}
