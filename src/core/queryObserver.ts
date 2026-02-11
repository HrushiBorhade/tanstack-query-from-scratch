/**
 * queryObserver.ts
 *
 * The bridge between a cached Query and a React component.
 *
 * One QueryObserver is created per useQuery hook call. Multiple observers can
 * watch the same Query (same queryKey) — they all share the underlying cached
 * data but each independently manages its own fetch-scheduling policy (staleTime,
 * refetchOnMount, refetchInterval, etc.).
 *
 * Responsibilities:
 * 1. Bind to the correct Query via the QueryCache (find or create via build()).
 * 2. Decide when to fetch: on mount, on window focus, on reconnect, on interval.
 * 3. Compute the rich QueryObserverResult from raw QueryState (derived booleans,
 *    placeholderData, select transform).
 * 4. Notify React (via listeners) only when relevant state changes.
 * 5. Manage staleTime timeout, refetchInterval timer, and lifecycle hooks.
 *
 * Circular dependency resolution:
 *   query.ts defines QueryObserverInterface (implemented here).
 *   queryCache.ts defines QueryClientInterface (without getQueryCache).
 *   We define a local QueryClientInterface here that extends the shape needed
 *   by the observer, avoiding any import from queryClient.ts.
 */

import type {
  QueryKey,
  QueryOptions,
  QueryObserverResult,
  RefetchOptions,
} from './types'
import { Subscribable } from './subscribable'
import { notifyManager } from './notifyManager'
import { timeUntilStale } from './utils'
import { Query } from './query'
import type { QueryObserverInterface } from './query'

// ---------------------------------------------------------------------------
// Local interface definitions — avoids circular imports
// ---------------------------------------------------------------------------

/**
 * The minimal slice of QueryCache that QueryObserver needs.
 *
 * Defined here rather than importing the full QueryCache class to prevent the
 * cycle: queryObserver → queryCache → (potentially) queryObserver.
 */
interface QueryCacheContract {
  build<TData, TError>(
    client: QueryClientInterface,
    options: QueryOptions<TData, TError>,
  ): Query<TData, TError>
}

/**
 * The minimal slice of QueryClient that QueryObserver requires.
 *
 * Keeps QueryObserver decoupled from the concrete QueryClient class. The real
 * QueryClient satisfies this interface structurally — no explicit `implements`
 * is needed there.
 */
export interface QueryClientInterface {
  getQueryCache(): QueryCacheContract
  defaultQueryOptions<TData, TError, TQueryKey extends QueryKey>(
    options: QueryOptions<TData, TError, TQueryKey>,
  ): QueryOptions<TData, TError, TQueryKey>
}

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

/** The function signature for callbacks registered with QueryObserver.subscribe(). */
export type QueryObserverListener<TData, TError> = (
  result: QueryObserverResult<TData, TError>,
) => void

// ---------------------------------------------------------------------------
// QueryObserver
// ---------------------------------------------------------------------------

/**
 * Bridges a Query (cache entry) and React.
 *
 * Implements QueryObserverInterface so the Query can call back into the observer
 * when its state transitions without knowing the observer's concrete type.
 */
export class QueryObserver<TData = unknown, TError = Error>
  extends Subscribable<QueryObserverListener<TData, TError>>
  implements QueryObserverInterface
{
  // -------------------------------------------------------------------------
  // Private fields
  // -------------------------------------------------------------------------

  /** The Query instance this observer is currently watching. */
  #currentQuery!: Query<TData, TError>

  /** The most recently computed rich result object (returned to React). */
  #currentResult!: QueryObserverResult<TData, TError>

  /**
   * Error caught while running options.select(). Stored so that it surfaces
   * as the result's error rather than crashing the notification pipeline.
   */
  #selectError: TError | null = null

  /**
   * The timestamp (ms) at which this observer mounted (first subscriber added).
   * Used to compute isFetchedAfterMount correctly.
   */
  #mountedAt = 0

  /** setInterval handle for automatic periodic refetching. */
  #refetchIntervalId?: ReturnType<typeof setInterval>

  /** setTimeout handle for the staleTime expiry notification. */
  #staleTimeoutId?: ReturnType<typeof setTimeout>

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(
    private client: QueryClientInterface,
    public options: QueryOptions<TData, TError>,
  ) {
    super()
    // Apply client defaults so the observer always works with a complete
    // options object (e.g. staleTime defaulted to 0, retry to 3, etc.).
    this.options = client.defaultQueryOptions(options)
    this.#updateQuery()
    this.#updateResult()
  }

  // -------------------------------------------------------------------------
  // Subscribable lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * Called when the first listener subscribes (component mounts).
   *
   * Side-effects started here are torn down in onUnsubscribe when the last
   * listener leaves. This keeps the observer "dormant" while no component
   * is interested in its data.
   */
  protected override onSubscribe(): void {
    if (this.listeners.size === 1) {
      // Record mount time for isFetchedAfterMount tracking.
      this.#mountedAt = Date.now()

      // Attach to the underlying Query so it can call onQueryUpdate().
      this.#currentQuery.addObserver(this)

      // Decide whether to kick off a fetch based on mount policy.
      this.#executeFetchIfNeeded('mount')

      // Schedule staleTime expiry notification (to flip isStale → true).
      this.#updateStaleTimeout()

      // Start periodic refetch interval if configured.
      this.#updateRefetchInterval()
    }
  }

  /**
   * Called when a listener unsubscribes (component unmounts or stops watching).
   *
   * When the last listener leaves, all side-effects are cleaned up and the
   * observer detaches from the Query (allowing the Query to schedule GC).
   */
  protected override onUnsubscribe(): void {
    if (!this.hasListeners()) {
      this.#clearStaleTimeout()
      this.#clearRefetchInterval()
      this.#currentQuery.removeObserver(this)
    }
  }

  // -------------------------------------------------------------------------
  // Query binding
  // -------------------------------------------------------------------------

  /**
   * Resolve the Query for the current options and bind to it.
   *
   * If the resolved query is the same instance as the current one, this is a
   * no-op. When the queryKey changes, we detach from the old Query and attach
   * to the new one (if we already have subscribers).
   */
  #updateQuery(): void {
    const query = this.client
      .getQueryCache()
      .build<TData, TError>(this.client, this.options)

    if (query === this.#currentQuery) return

    const prevQuery = this.#currentQuery
    this.#currentQuery = query

    // If we are already active (have listeners), re-register with the new query.
    if (this.hasListeners()) {
      prevQuery?.removeObserver(this)
      query.addObserver(this)
    }
  }

  // -------------------------------------------------------------------------
  // Result computation
  // -------------------------------------------------------------------------

  /**
   * Compute the rich QueryObserverResult from raw QueryState.
   *
   * This is the heart of the observer. It derives all boolean flags, applies
   * the select transform, injects placeholderData, and calculates isStale.
   * The result is stored in #currentResult and returned to React via
   * getCurrentResult() / getOptimisticResult().
   */
  #updateResult(): void {
    const state = this.#currentQuery.state
    const options = this.options

    // ---- Fetch status derivations -----------------------------------------
    const isFetching = state.fetchStatus === 'fetching'
    const isPaused = state.fetchStatus === 'paused'

    // isLoading: the very first load — pending status AND actively fetching.
    const isLoading = state.status === 'pending' && isFetching

    // isRefetching: a background refetch after data has already been received.
    const isRefetching = isFetching && state.status !== 'pending'

    // ---- Data / select / placeholderData -----------------------------------
    let data: TData | undefined = state.data
    let isPlaceholderData = false

    // Apply the select transform if one was provided and data is available.
    if (options.select && state.data !== undefined) {
      try {
        data = options.select(state.data)
        // Clear any previous select error if this run succeeded.
        this.#selectError = null
      } catch (selectError) {
        // Capture the error so it surfaces in the result without crashing
        // the notification pipeline. The previous data (if any) is retained.
        this.#selectError = selectError as TError
      }
    }

    // If we have no real data yet (or it was undefined), inject placeholder data.
    if (data === undefined && options.placeholderData !== undefined) {
      const placeholder =
        typeof options.placeholderData === 'function'
          ? (options.placeholderData as (prev: TData | undefined) => TData | undefined)(
              this.#currentResult?.data,
            )
          : options.placeholderData

      if (placeholder !== undefined) {
        data = placeholder
        isPlaceholderData = true
      }
    }

    // ---- Status derivation -------------------------------------------------
    // A select error overrides any data; treat it as an error state.
    const error = this.#selectError ?? state.error

    // Derive the display status: if we have data (real or placeholder) show
    // success, otherwise fall back to the raw state status.
    let status = state.status
    if (error !== null && data === undefined) {
      status = 'error'
    } else if (state.status === 'success' || data !== undefined) {
      status = 'success'
    }

    // ---- isFetchedAfterMount -----------------------------------------------
    // True once the query has successfully updated *after* this observer mounted.
    const isFetchedAfterMount =
      this.#mountedAt > 0 && state.dataUpdatedAt > this.#mountedAt

    // ---- staleTime ---------------------------------------------------------
    const staleTime = options.staleTime

    // ---- Assemble the result -----------------------------------------------
    this.#currentResult = {
      data,
      dataUpdatedAt: state.dataUpdatedAt,
      error: error as TError | null,
      errorUpdatedAt: state.errorUpdatedAt,
      failureCount: state.fetchFailureCount,
      failureReason: state.fetchFailureReason,
      fetchStatus: state.fetchStatus,
      isError: status === 'error',
      isFetched: state.dataUpdatedAt > 0,
      isFetchedAfterMount,
      isFetching,
      isLoading,
      isLoadingError: status === 'error' && !isRefetching,
      isPaused,
      isPending: status === 'pending',
      isPlaceholderData,
      isRefetchError: status === 'error' && isRefetching,
      isRefetching,
      isStale: this.#currentQuery.isStaleByTime(staleTime),
      isSuccess: status === 'success',
      refetch: (refetchOptions?: RefetchOptions) => this.refetch(refetchOptions),
      status,
    }
  }

  // -------------------------------------------------------------------------
  // QueryObserverInterface — called by Query on every state transition
  // -------------------------------------------------------------------------

  /**
   * Called by the Query (via notifyManager.batch) whenever its state changes.
   *
   * Recomputes the rich result and pushes it to all registered React listeners.
   * The stale timeout is also recalculated since new data resets the staleTime
   * clock.
   */
  onQueryUpdate(): void {
    this.#updateResult()
    this.#updateStaleTimeout()
    notifyManager.batch(() => {
      this.listeners.forEach((listener) => listener(this.#currentResult))
    })
  }

  // -------------------------------------------------------------------------
  // Public API — used by useQuery hook
  // -------------------------------------------------------------------------

  /**
   * Return the most recently computed result.
   *
   * Called by useSyncExternalStore's getSnapshot argument so React can read
   * the current value without subscribing.
   */
  getCurrentResult(): QueryObserverResult<TData, TError> {
    return this.#currentResult
  }

  /**
   * Compute the result for a given set of options without side-effects.
   *
   * Called before subscription in useQuery to avoid a flicker on initial render.
   * The observer temporarily switches to the target Query, computes the result,
   * then restores the previous query reference.
   *
   * @param options - Options to evaluate (may differ from current options).
   */
  getOptimisticResult(
    options: QueryOptions<TData, TError>,
  ): QueryObserverResult<TData, TError> {
    const mergedOptions = this.client.defaultQueryOptions(options)
    const query = this.client
      .getQueryCache()
      .build<TData, TError>(this.client, mergedOptions)

    // Temporarily swap the current query to compute the result for the new
    // query state, then restore the original reference.
    const prevQuery = this.#currentQuery
    const prevOptions = this.options
    this.#currentQuery = query
    this.options = mergedOptions
    this.#updateResult()
    this.#currentQuery = prevQuery
    this.options = prevOptions

    return this.#currentResult
  }

  /**
   * Update the observer's options and re-evaluate everything that may have
   * changed (query binding, fetch policy, stale timeout, refetch interval).
   *
   * Called by the useQuery hook's useEffect when React renders with new props.
   *
   * @param options - The updated options from the latest render.
   */
  setOptions(options: QueryOptions<TData, TError>): void {
    const prevOptions = this.options
    this.options = this.client.defaultQueryOptions(options)

    // Re-bind to the correct Query in case the queryKey changed.
    this.#updateQuery()

    // If the queryKey or enabled flag changed, we might need to (re)start a
    // fetch. Only check this while subscribed, since unsubscribed observers
    // should not trigger fetches.
    if (
      this.hasListeners() &&
      (prevOptions.queryKey !== this.options.queryKey ||
        prevOptions.enabled !== this.options.enabled)
    ) {
      this.#executeFetchIfNeeded('options-changed')
    }

    this.#updateStaleTimeout()
    this.#updateRefetchInterval()
    this.#updateResult()
  }

  /**
   * Imperatively trigger a refetch and return the final result.
   *
   * Errors are swallowed at this level — they are always reflected in the
   * result object. The caller can opt in to re-thrown errors by checking
   * options.throwOnError (not implemented here — reserved for future use).
   *
   * @param options - Refetch behaviour options (e.g. cancelRefetch).
   */
  async refetch(
    options?: RefetchOptions,
  ): Promise<QueryObserverResult<TData, TError>> {
    return this.#currentQuery
      .fetch(this.options, {
        cancelRefetch: options?.cancelRefetch ?? true,
      })
      .then(() => this.getCurrentResult())
      .catch(() => this.getCurrentResult())
  }

  // -------------------------------------------------------------------------
  // Window focus / reconnect hooks — called by QueryCache
  // -------------------------------------------------------------------------

  /**
   * Called by QueryCache.onFocus() when the browser window regains focus.
   *
   * The observer decides whether to refetch based on its refetchOnWindowFocus
   * option and current staleness.
   */
  onFocus(): void {
    this.#executeFetchIfNeeded('focus')
  }

  /**
   * Called by QueryCache (via OnlineManager) when the network reconnects.
   *
   * The observer decides whether to refetch based on its refetchOnReconnect
   * option and current staleness.
   */
  onOnline(): void {
    this.#executeFetchIfNeeded('reconnect')
  }

  // -------------------------------------------------------------------------
  // Fetch gating — the staleness / policy gate
  // -------------------------------------------------------------------------

  /**
   * Determine whether a fetch should be triggered for the given reason and,
   * if so, kick one off.
   *
   * Policy matrix:
   *  - enabled: false → never fetch
   *  - reason === 'mount':     controlled by refetchOnMount (default: true)
   *  - reason === 'focus':     controlled by refetchOnWindowFocus (default: true)
   *  - reason === 'reconnect': controlled by refetchOnReconnect (default: true)
   *  - reason === 'options-changed': only fetch if enabled just became true
   *
   * For each policy, 'always' means always fetch regardless of staleness, while
   * true/false means "fetch if stale" / "never fetch" respectively.
   */
  #executeFetchIfNeeded(
    reason: 'mount' | 'focus' | 'reconnect' | 'options-changed',
  ): void {
    const options = this.options
    const query = this.#currentQuery

    // Never fetch when the query is disabled.
    if (options.enabled === false) return

    const staleTime = options.staleTime ?? 0

    const isStale = query.isStaleByTime(staleTime)

    if (reason === 'mount') {
      const policy = options.refetchOnMount ?? true
      if (policy === false) return
      if (policy === 'always' || isStale) {
        void query.fetch(options)
      }
    } else if (reason === 'focus') {
      const policy = options.refetchOnWindowFocus ?? true
      if (policy === false) return
      if (policy === 'always' || isStale) {
        void query.fetch(options)
      }
    } else if (reason === 'reconnect') {
      const policy = options.refetchOnReconnect ?? true
      if (policy === false) return
      if (policy === 'always' || isStale) {
        void query.fetch(options)
      }
    } else if (reason === 'options-changed') {
      // When options change (e.g. enabled flips to true), trigger a fetch if
      // the query is stale or has never been fetched.
      if (isStale) {
        void query.fetch(options)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stale timeout management
  // -------------------------------------------------------------------------

  /**
   * Schedule a notification to fire when the current data becomes stale.
   *
   * This drives the isStale flag transition inside the result object so React
   * components re-render at the right moment (e.g. to show a "Refreshing…"
   * indicator), without needing a polling loop.
   *
   * Short-circuits for:
   * - staleTime === 'static' (data never goes stale)
   * - staleTime === Infinity (same semantics)
   * - No data yet (dataUpdatedAt === 0)
   */
  #updateStaleTimeout(): void {
    this.#clearStaleTimeout()

    const staleTime = this.options.staleTime

    // 'static' and Infinity both mean "data never becomes stale on its own".
    if (staleTime === 'static' || staleTime === Infinity) return

    const numericStaleTime = staleTime ?? 0

    // No data → nothing to schedule.
    if (this.#currentQuery.state.dataUpdatedAt === 0) return

    const timeUntil = timeUntilStale(
      this.#currentQuery.state.dataUpdatedAt,
      numericStaleTime,
    )

    // If already stale, no need to schedule — result already shows isStale: true.
    if (timeUntil <= 0) return

    // +1 ms avoids premature firing in environments with slightly imprecise
    // setTimeout implementations.
    this.#staleTimeoutId = setTimeout(() => {
      this.#updateResult()
      notifyManager.batch(() => {
        this.listeners.forEach((listener) => listener(this.#currentResult))
      })
    }, timeUntil + 1)
  }

  /** Cancel any pending stale timeout. Safe to call when none is set. */
  #clearStaleTimeout(): void {
    if (this.#staleTimeoutId !== undefined) {
      clearTimeout(this.#staleTimeoutId)
      this.#staleTimeoutId = undefined
    }
  }

  // -------------------------------------------------------------------------
  // Refetch interval management
  // -------------------------------------------------------------------------

  /**
   * Start (or restart) the periodic refetch interval timer.
   *
   * Skipped when:
   * - refetchInterval is falsy or 0
   * - enabled === false
   *
   * The interval callback checks document.visibilityState at fire time so
   * that background tabs do not consume network resources unnecessarily
   * (unless refetchIntervalInBackground is true).
   *
   * Note: refetchIntervalInBackground is not part of the QueryOptions type
   * declared in types.ts, so we read it via a type assertion to keep the
   * implementation future-proof without modifying the shared types.
   */
  #updateRefetchInterval(): void {
    this.#clearRefetchInterval()

    const interval =
      typeof this.options.refetchInterval === 'function'
        ? (this.options.refetchInterval as (query: Query<TData, TError>) => number | false)(
            this.#currentQuery,
          )
        : this.options.refetchInterval

    // Guard: no interval, interval is explicitly false/0, or query is disabled.
    if (!interval || interval <= 0 || this.options.enabled === false) return

    const refetchIntervalInBackground = (
      this.options as QueryOptions<TData, TError> & {
        refetchIntervalInBackground?: boolean
      }
    ).refetchIntervalInBackground

    this.#refetchIntervalId = setInterval(() => {
      // Skip the fetch if the tab is hidden and the option does not allow
      // background refetching. We check at fire time rather than scheduling
      // time so that a tab hidden after the interval starts is still guarded.
      const isHidden =
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'

      if (!isHidden || refetchIntervalInBackground) {
        void this.#currentQuery.fetch(this.options)
      }
    }, interval)
  }

  /** Cancel any running refetch interval timer. Safe to call when none is set. */
  #clearRefetchInterval(): void {
    if (this.#refetchIntervalId !== undefined) {
      clearInterval(this.#refetchIntervalId)
      this.#refetchIntervalId = undefined
    }
  }
}
