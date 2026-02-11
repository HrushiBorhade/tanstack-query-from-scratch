/**
 * types.ts
 *
 * Single source of truth for all TypeScript types and interfaces used across
 * the tanstack-query-from-scratch implementation. No runtime code lives here —
 * pure type definitions only.
 */

// ---------------------------------------------------------------------------
// Query Key & Hash
// ---------------------------------------------------------------------------

/** A query key is any stable, serializable array used to uniquely identify a query. */
export type QueryKey = ReadonlyArray<unknown>

/** A stable string representation of a QueryKey, produced by hashQueryKey(). */
export type QueryHash = string

// ---------------------------------------------------------------------------
// Status Types
// ---------------------------------------------------------------------------

/**
 * The "data availability" axis of a query's state machine.
 *
 * - pending  : No data yet (initial state or after a reset)
 * - success  : Data was fetched successfully
 * - error    : The last fetch attempt threw an error
 */
export type QueryStatus = 'pending' | 'success' | 'error'

/**
 * The "network activity" axis of a query's state machine.
 * Orthogonal to QueryStatus — a query can be both 'success' and 'fetching'
 * at the same time (background refetch).
 *
 * - fetching : A network request is currently in-flight
 * - paused   : A fetch was requested but is waiting for the network
 * - idle     : No fetch is happening
 */
export type FetchStatus = 'fetching' | 'paused' | 'idle'

// ---------------------------------------------------------------------------
// Query State
// ---------------------------------------------------------------------------

/**
 * The complete, serializable state object stored in the QueryCache for each
 * cached query. It is the single source of truth for what the query knows.
 */
export interface QueryState<TData = unknown, TError = Error> {
  /** The successfully fetched data, or undefined if not yet available. */
  data: TData | undefined
  /** Unix timestamp (ms) of the most recent successful data update. */
  dataUpdatedAt: number
  /** The error thrown by the last failed fetch attempt, or null. */
  error: TError | null
  /** Unix timestamp (ms) of the most recent error. */
  errorUpdatedAt: number
  /** How many consecutive fetch attempts have failed in the current retry sequence. */
  fetchFailureCount: number
  /** The error from the most recent failed fetch attempt in the current sequence. */
  fetchFailureReason: TError | null
  /** Current network activity status. */
  fetchStatus: FetchStatus
  /**
   * Whether this query has been manually invalidated (e.g. via
   * queryClient.invalidateQueries). Invalidated queries refetch on next mount.
   */
  isInvalidated: boolean
  /** Current data-availability status. */
  status: QueryStatus
}

// ---------------------------------------------------------------------------
// Query Function
// ---------------------------------------------------------------------------

/**
 * The context object passed as the sole argument to every queryFn.
 * Provides the query key, an AbortSignal for cancellation, and any metadata.
 */
export interface QueryFunctionContext<TQueryKey extends QueryKey = QueryKey> {
  /** The query key that triggered this fetch. */
  queryKey: TQueryKey
  /**
   * An AbortSignal that is aborted when the query is cancelled or the
   * component unmounts. Pass this to fetch() / axios to enable cancellation.
   */
  signal: AbortSignal
  /** Arbitrary metadata attached to the query via QueryOptions.meta. */
  meta: QueryMeta | undefined
}

/**
 * The user-provided async function that fetches data for a query.
 * It receives a QueryFunctionContext and must return TData or a Promise<TData>.
 */
export type QueryFunction<TData = unknown, TQueryKey extends QueryKey = QueryKey> = (
  context: QueryFunctionContext<TQueryKey>,
) => TData | Promise<TData>

/** Arbitrary key-value metadata that can be attached to a query or mutation. */
export type QueryMeta = Record<string, unknown>

// ---------------------------------------------------------------------------
// Query Options
// ---------------------------------------------------------------------------

/**
 * Full configuration object for a query. Used both when defining a query
 * (useQuery options) and when pre-seeding the cache (QueryClient.prefetchQuery).
 */
export interface QueryOptions<
  TData = unknown,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
> {
  /** The unique key identifying this query in the cache. Required. */
  queryKey: TQueryKey
  /** The async function that fetches data. Optional if seeding via setQueryData. */
  queryFn?: QueryFunction<TData, TQueryKey>
  /**
   * How long (ms) data is considered fresh. While fresh, no background refetch
   * is triggered. Use 'static' to indicate data that never goes stale.
   * Defaults to 0 (always stale).
   */
  staleTime?: number | 'static'
  /**
   * How long (ms) inactive query data stays in memory after all observers
   * unsubscribe. Defaults to 5 minutes. Set to Infinity to keep forever.
   */
  gcTime?: number
  /**
   * How many times to retry a failed query before surfacing the error.
   * Can be a boolean, a number, or a function for dynamic retry logic.
   * Defaults to 3.
   */
  retry?: boolean | number | ((failureCount: number, error: TError) => boolean)
  /**
   * Delay (ms) between retry attempts.
   * Can be a number or a function receiving the attempt number and last error.
   */
  retryDelay?: number | ((retryAttempt: number, error: TError) => number)
  /**
   * When false, the query will not fetch automatically. Useful for dependent
   * queries. Defaults to true.
   */
  enabled?: boolean
  /**
   * Whether to refetch when a new observer mounts.
   * - true     : refetch if stale
   * - false    : never refetch on mount
   * - 'always' : always refetch on mount regardless of staleness
   */
  refetchOnMount?: boolean | 'always'
  /**
   * Whether to refetch when the browser window regains focus.
   * - true     : refetch if stale
   * - false    : never refetch on focus
   * - 'always' : always refetch on focus
   */
  refetchOnWindowFocus?: boolean | 'always'
  /**
   * Whether to refetch when the network reconnects.
   * - true     : refetch if stale
   * - false    : never refetch on reconnect
   * - 'always' : always refetch on reconnect
   */
  refetchOnReconnect?: boolean | 'always'
  /**
   * Interval (ms) at which to automatically refetch. Set to false to disable.
   * Defaults to false.
   */
  refetchInterval?: number | false
  /**
   * Controls when fetches are allowed relative to network availability.
   * - 'online'       : only fetch when online (default)
   * - 'always'       : always fetch regardless of network
   * - 'offlineFirst' : fetch immediately, retry online
   */
  networkMode?: 'online' | 'always' | 'offlineFirst'
  /** Arbitrary metadata passed through to queryFn and global callbacks. */
  meta?: QueryMeta
  /**
   * Pre-populate the cache with this data before the first fetch completes.
   * Can be a value or a factory function.
   */
  initialData?: TData | (() => TData)
  /**
   * Timestamp (ms) to associate with initialData so staleTime is evaluated
   * correctly against it.
   */
  initialDataUpdatedAt?: number | (() => number | undefined)
  /**
   * Data to display while a query is in the 'pending' state, without writing
   * it into the real cache. The result will have isPlaceholderData: true.
   * Can be a value or a function receiving the previous successful data.
   */
  placeholderData?: TData | ((previousData: TData | undefined) => TData | undefined)
  /**
   * Transform the data returned by queryFn before storing it. Runs on every
   * successful fetch, including background refetches.
   */
  select?: (data: TData) => TData
  /**
   * Custom function to hash the query key. Defaults to hashQueryKey() from utils.
   * Override for special serialization needs (e.g. ignoring certain fields).
   */
  queryKeyHashFn?: (queryKey: QueryKey) => string
}

// ---------------------------------------------------------------------------
// Query Observer Result
// ---------------------------------------------------------------------------

/**
 * The rich result object returned by useQuery / QueryObserver.
 * All boolean flags are derived from status + fetchStatus for convenience.
 */
export interface QueryObserverResult<TData = unknown, TError = Error> {
  /** The most recently successfully fetched data, or undefined. */
  data: TData | undefined
  /** Unix timestamp (ms) of the most recent successful data update. */
  dataUpdatedAt: number
  /** The error thrown by the last failed attempt, or null. */
  error: TError | null
  /** Unix timestamp (ms) of the most recent error. */
  errorUpdatedAt: number
  /** Number of consecutive failures in the current retry sequence. */
  failureCount: number
  /** The error reason for the most recent failure in the current sequence. */
  failureReason: TError | null
  /** Current network activity status. */
  fetchStatus: FetchStatus
  /** true when status === 'error'. */
  isError: boolean
  /** true when data has been successfully fetched at least once. */
  isFetched: boolean
  /** true when data has been successfully fetched at least once after this observer mounted. */
  isFetchedAfterMount: boolean
  /** true when fetchStatus === 'fetching'. */
  isFetching: boolean
  /**
   * true when status === 'pending' AND fetchStatus === 'fetching'.
   * The classic "first load" loading state.
   */
  isLoading: boolean
  /** true when status === 'error' AND data has never been fetched. */
  isLoadingError: boolean
  /** true when fetchStatus === 'paused'. */
  isPaused: boolean
  /** true when status === 'pending'. */
  isPending: boolean
  /** true when data is being shown from placeholderData (not the real cache). */
  isPlaceholderData: boolean
  /** true when status === 'error' AND data was previously fetched successfully. */
  isRefetchError: boolean
  /** true when fetchStatus === 'fetching' AND data was previously fetched. */
  isRefetching: boolean
  /** true when data exists and is older than staleTime. */
  isStale: boolean
  /** true when status === 'success'. */
  isSuccess: boolean
  /** Imperatively trigger a refetch for this query. */
  refetch: (options?: RefetchOptions) => Promise<QueryObserverResult<TData, TError>>
  /** Current data-availability status. */
  status: QueryStatus
}

/** Options for the imperative refetch() call. */
export interface RefetchOptions {
  /** If true, throw errors instead of silently returning them in the result. */
  throwOnError?: boolean
  /**
   * If true (default), cancel any in-flight refetch and start a new one.
   * If false, do nothing if a refetch is already in progress.
   */
  cancelRefetch?: boolean
}

// ---------------------------------------------------------------------------
// Query Filters
// ---------------------------------------------------------------------------

/**
 * Used to filter which cached queries are targeted by operations like
 * invalidateQueries, removeQueries, refetchQueries, etc.
 */
export interface QueryFilters {
  /** Only match queries with this exact or partial key. */
  queryKey?: QueryKey
  /** When true, only match queries whose key exactly equals queryKey. */
  exact?: boolean
  /** Filter by observer subscription status. */
  type?: 'active' | 'inactive' | 'all'
  /** Filter by staleness. */
  stale?: boolean
  /** Filter by current fetch activity. */
  fetchStatus?: FetchStatus
  /** Arbitrary predicate for custom filtering logic. */
  predicate?: (query: { queryKey: QueryKey; queryHash: QueryHash; state: QueryState }) => boolean
}

// ---------------------------------------------------------------------------
// Mutation Types
// ---------------------------------------------------------------------------

/**
 * The lifecycle status of a mutation.
 *
 * - idle    : Never called or has been reset
 * - pending : Currently executing
 * - success : Completed successfully
 * - error   : Failed with an error
 */
export type MutationStatus = 'idle' | 'pending' | 'success' | 'error'

/** The complete state for a single mutation instance. */
export interface MutationState<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> {
  /** Value returned by onMutate, shared with onSuccess/onError/onSettled. */
  context: TContext | undefined
  /** Data returned by a successful mutationFn, or undefined. */
  data: TData | undefined
  /** Error thrown by the mutationFn, or null. */
  error: TError | null
  /** Number of consecutive failures in the current retry sequence. */
  failureCount: number
  /** The error from the most recent failed attempt. */
  failureReason: TError | null
  /** true when a mutation was attempted but is paused waiting for network. */
  isPaused: boolean
  /** Current lifecycle status. */
  status: MutationStatus
  /** The variables passed to the most recent mutate() / mutateAsync() call. */
  variables: TVariables | undefined
  /** Unix timestamp (ms) when the mutation was submitted. */
  submittedAt: number
}

/**
 * The user-provided async function that performs the mutation.
 * Unlike queryFn, it does not receive context — variables are passed directly.
 */
export type MutationFunction<TData = unknown, TVariables = unknown> = (
  variables: TVariables,
) => Promise<TData>

/** Full configuration object for a mutation. */
export interface MutationOptions<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> {
  /** Optional key for deduplication and DevTools labelling. */
  mutationKey?: QueryKey
  /** The async function that performs the side-effect. */
  mutationFn?: MutationFunction<TData, TVariables>
  /** Retry policy — same semantics as QueryOptions.retry. */
  retry?: boolean | number | ((failureCount: number, error: TError) => boolean)
  /** Retry delay policy — same semantics as QueryOptions.retryDelay. */
  retryDelay?: number | ((retryAttempt: number, error: TError) => number)
  /** Network mode — same semantics as QueryOptions.networkMode. */
  networkMode?: 'online' | 'always' | 'offlineFirst'
  /** How long (ms) to keep a finished mutation in the cache. Defaults to 0. */
  gcTime?: number
  /**
   * Runs before the mutationFn. Return a context object to share with
   * onSuccess / onError / onSettled. Useful for optimistic updates.
   */
  onMutate?: (variables: TVariables) => Promise<TContext | undefined> | TContext | undefined
  /** Runs after a successful mutationFn. */
  onSuccess?: (data: TData, variables: TVariables, context: TContext | undefined) => Promise<unknown> | unknown
  /** Runs after the mutationFn throws. */
  onError?: (error: TError, variables: TVariables, context: TContext | undefined) => Promise<unknown> | unknown
  /** Runs after onSuccess or onError, regardless of outcome. */
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => Promise<unknown> | unknown
  /** Arbitrary metadata attached to this mutation. */
  meta?: QueryMeta
}

/**
 * The rich result object returned by useMutation / MutationObserver.
 * Extends MutationState with convenience booleans and callable functions.
 */
export interface MutationObserverResult<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> extends MutationState<TData, TError, TVariables, TContext> {
  /** true when status === 'error'. */
  isError: boolean
  /** true when status === 'idle'. */
  isIdle: boolean
  /** true when status === 'pending'. */
  isPending: boolean
  /** true when status === 'success'. */
  isSuccess: boolean
  /**
   * Fire-and-forget version of mutateAsync. Errors are surfaced via the result
   * object rather than thrown.
   */
  mutate: (variables: TVariables, options?: MutateOptions<TData, TError, TVariables, TContext>) => void
  /** Promise-based mutation call. Throws on error. */
  mutateAsync: (
    variables: TVariables,
    options?: MutateOptions<TData, TError, TVariables, TContext>,
  ) => Promise<TData>
  /** Reset the mutation back to its idle state. */
  reset: () => void
}

/**
 * Per-call lifecycle callbacks passed to mutate() / mutateAsync().
 * These run in addition to (after) the callbacks defined in MutationOptions.
 */
export interface MutateOptions<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> {
  onSuccess?: (data: TData, variables: TVariables, context: TContext | undefined) => Promise<unknown> | unknown
  onError?: (error: TError, variables: TVariables, context: TContext | undefined) => Promise<unknown> | unknown
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => Promise<unknown> | unknown
}

// ---------------------------------------------------------------------------
// QueryClient Configuration
// ---------------------------------------------------------------------------

/**
 * Default options applied to all queries / mutations created by the client
 * unless overridden at the individual query/mutation level.
 */
export interface DefaultOptions {
  queries?: Omit<QueryOptions, 'queryKey' | 'queryFn'>
  mutations?: Omit<MutationOptions, 'mutationFn'>
}

/** Top-level configuration object passed to the QueryClient constructor. */
export interface QueryClientConfig {
  defaultOptions?: DefaultOptions
}
