/**
 * mutation.ts
 *
 * The Mutation class represents a single mutation execution and owns its
 * complete state machine lifecycle.
 *
 * Key design decisions vs. Query:
 *
 * - No caching: every mutate() call is a fresh execution. The Mutation instance
 *   is kept in MutationCache only so that MutationObservers can subscribe to
 *   state updates; it is removed (via gcTime) once the caller is done.
 *
 * - Ordered lifecycle hooks: onMutate → mutationFn (via Retryer) → onSuccess
 *   or onError → onSettled. This ordering is critical: the value returned by
 *   onMutate is the "context" that enables optimistic update rollback in onError.
 *
 * - Context threading: the context returned by onMutate is stored in state
 *   via a 'setContext' dispatch before the mutationFn is awaited. This means
 *   even if the process crashes between onMutate and onError, the context is
 *   in the serialisable state object and could theoretically be recovered.
 *
 * - retry defaults to 0: mutations should not retry by default because they
 *   perform side-effects. Retrying a non-idempotent mutation (e.g. a payment)
 *   without the caller's knowledge would be dangerous.
 *
 * - gcTime defaults to 0: finished mutations have no reason to linger in
 *   memory. As soon as the last observer unsubscribes, GC is scheduled
 *   immediately (setTimeout 0 effectively).
 */

import type { MutationOptions, MutationState } from './types'
import { Removable } from './removable'
import { Retryer } from './retryer'
import { notifyManager } from './notifyManager'

// ---------------------------------------------------------------------------
// MutationAction — the discriminated union that drives the state machine
// ---------------------------------------------------------------------------

/**
 * Every state transition in a Mutation is expressed as one of these action
 * objects. The reducer is a pure function (state, action) => state so the
 * state machine is easy to test in isolation.
 */
export type MutationAction<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> =
  | { type: 'pending'; variables: TVariables; submittedAt: number }
  | { type: 'setContext'; context: TContext | undefined }
  | { type: 'success'; data: TData }
  | { type: 'error'; error: TError }
  | { type: 'failed'; failureCount: number; error: TError }
  | { type: 'reset' }

// ---------------------------------------------------------------------------
// Interfaces for the MutationCache and MutationObserver boundaries
//
// These are defined here (rather than in mutationCache.ts / mutationObserver.ts)
// because Mutation needs to reference them and we want to avoid circular imports.
// When those files are created they will implement these interfaces.
// ---------------------------------------------------------------------------

/**
 * Minimal interface that Mutation needs from the MutationCache.
 *
 * The full MutationCache class will implement this interface. Defining a
 * narrow interface here keeps the coupling explicit and testable — unit tests
 * can supply a simple mock rather than wiring up the entire cache.
 */
export interface MutationCacheInterface {
  config: {
    /**
     * Global success callback. Runs after the per-mutation onSuccess, giving
     * the application a single place to react to every successful mutation
     * (e.g. to trigger a refetch of related queries).
     */
    onSuccess?: <TData, TError, TVariables, TContext>(
      data: TData,
      variables: TVariables,
      context: TContext | undefined,
      mutation: Mutation<TData, TError, TVariables, TContext>,
    ) => Promise<unknown> | unknown
    /** Global error callback — runs after the per-mutation onError. */
    onError?: <TData, TError, TVariables, TContext>(
      error: TError,
      variables: TVariables,
      context: TContext | undefined,
      mutation: Mutation<TData, TError, TVariables, TContext>,
    ) => Promise<unknown> | unknown
    /** Global settled callback — runs after the per-mutation onSettled. */
    onSettled?: <TData, TError, TVariables, TContext>(
      data: TData | undefined,
      error: TError | null,
      variables: TVariables,
      context: TContext | undefined,
      mutation: Mutation<TData, TError, TVariables, TContext>,
    ) => Promise<unknown> | unknown
    /**
     * Global onMutate callback — runs before the mutationFn, just like the
     * per-mutation onMutate. Useful for global side-effects like showing a
     * global loading indicator.
     */
    onMutate?: <TData, TError, TVariables, TContext>(
      variables: TVariables,
      mutation: Mutation<TData, TError, TVariables, TContext>,
    ) => Promise<unknown> | unknown
  }
  /** Emit a cache-level event so subscribers (e.g. DevTools) can react. */
  notify(event: MutationCacheNotifyEvent): void
  /** Remove a mutation from the cache immediately. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  remove(mutation: Mutation<any, any, any, any>): void
}

/**
 * Events emitted by MutationCache.notify(). Consumers (DevTools, tests)
 * subscribe to these via MutationCache.subscribe().
 *
 * We use `any` on the Mutation type parameters here because these events are
 * emitted at the cache level where the concrete types have been erased.
 * Subscribers that need type-safe access should cast after narrowing on `type`.
 */
export type MutationCacheNotifyEvent =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: 'added'; mutation: Mutation<any, any, any, any> }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: 'removed'; mutation: Mutation<any, any, any, any> }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: 'updated'; mutation: Mutation<any, any, any, any>; action: MutationAction<any, any, any, any> }

/**
 * Minimal interface that a MutationObserver must implement to receive state
 * updates from the Mutation it is observing.
 *
 * The full MutationObserver class will implement this interface. The narrow
 * interface keeps Mutation decoupled from the observer implementation.
 */
export interface MutationObserverInterface<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> {
  /**
   * Called by Mutation.#dispatch() after every state transition, batched via
   * notifyManager. Observers use this to recompute their derived result objects
   * and trigger UI re-renders.
   */
  onMutationUpdate(action: MutationAction<TData, TError, TVariables, TContext>): void
}

// ---------------------------------------------------------------------------
// MutationConfig — constructor argument
// ---------------------------------------------------------------------------

/**
 * Configuration passed to the Mutation constructor.
 *
 * The MutationCache creates Mutation instances, so it supplies its own
 * reference (mutationCache) plus the resolved options for the mutation.
 * `defaultOptions` are merged in so that the Mutation instance owns a single
 * fully-resolved options object.
 */
export interface MutationConfig<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> {
  /** The owning cache. Used to emit notify events and to remove this mutation. */
  mutationCache: MutationCacheInterface
  /** The user-provided options for this specific mutation call. */
  options: MutationOptions<TData, TError, TVariables, TContext>
  /**
   * Default options from QueryClient.defaultOptions.mutations, applied before
   * the per-mutation options so they can be overridden at call site.
   */
  defaultOptions?: MutationOptions<TData, TError, TVariables, TContext>
}

// ---------------------------------------------------------------------------
// State reducer — pure function, easy to unit-test
// ---------------------------------------------------------------------------

/**
 * Produces the next MutationState given the current state and an action.
 *
 * This is intentionally a module-level function (not a method) so it can be
 * tested in complete isolation, without constructing a Mutation instance.
 */
function reducer<TData, TError, TVariables, TContext>(
  state: MutationState<TData, TError, TVariables, TContext>,
  action: MutationAction<TData, TError, TVariables, TContext>,
): MutationState<TData, TError, TVariables, TContext> {
  switch (action.type) {
    case 'pending':
      return {
        ...state,
        status: 'pending',
        variables: action.variables,
        submittedAt: action.submittedAt,
        // Reset outcome fields from any previous execution so the new attempt
        // starts with a clean slate.
        error: null,
        failureCount: 0,
        failureReason: null,
        isPaused: false,
        data: undefined,
        context: undefined,
      }

    case 'setContext':
      // Store the context returned by onMutate. This must happen before the
      // mutationFn is awaited so that the context is available for rollback
      // in onError even if the process crashes mid-execution.
      return { ...state, context: action.context }

    case 'success':
      return {
        ...state,
        status: 'success',
        data: action.data,
        // Clear the paused flag in case the mutation was paused before success.
        isPaused: false,
      }

    case 'error':
      return {
        ...state,
        status: 'error',
        error: action.error,
        isPaused: false,
      }

    case 'failed':
      // Intermediate retry failure — update counters but keep status 'pending'.
      return {
        ...state,
        failureCount: action.failureCount,
        failureReason: action.error,
      }

    case 'reset':
      // Return to the initial idle state, discarding all execution history.
      return {
        context: undefined,
        data: undefined,
        error: null,
        failureCount: 0,
        failureReason: null,
        isPaused: false,
        status: 'idle',
        variables: undefined,
        submittedAt: 0,
      }
  }
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * A single mutation execution with a full state machine and lifecycle hooks.
 *
 * Type parameters:
 *   TData      — the value returned by a successful mutationFn
 *   TError     — the error type thrown by mutationFn (default: Error)
 *   TVariables — the argument type accepted by mutationFn
 *   TContext   — the value returned by onMutate, used for optimistic rollback
 */
export class Mutation<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
> extends Removable {
  // ---------------------------------------------------------------------------
  // Public state
  // ---------------------------------------------------------------------------

  /**
   * The current serialisable state of this mutation.
   *
   * Publicly readable so that MutationObserver can snapshot it when computing
   * the derived result object. Mutated only via #dispatch().
   */
  state: MutationState<TData, TError, TVariables, TContext>

  /**
   * The fully-resolved options for this mutation (defaultOptions merged with
   * per-mutation options).
   */
  options: MutationOptions<TData, TError, TVariables, TContext>

  // ---------------------------------------------------------------------------
  // Private fields
  // ---------------------------------------------------------------------------

  /**
   * All MutationObservers currently subscribed to this mutation.
   * They are notified on every state transition via #dispatch().
   */
  #observers: MutationObserverInterface<TData, TError, TVariables, TContext>[]

  /**
   * The Retryer managing the current mutationFn execution, if one is in
   * progress. Stored so future extensions (e.g. pause/resume) can reference it.
   * Not used for cancellation in the MVP — mutations are fire-and-forget.
   */
  #retryer?: Retryer<TData, TError>

  /** Reference to the owning MutationCache. */
  #cache: MutationCacheInterface

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(config: MutationConfig<TData, TError, TVariables, TContext>) {
    super()

    this.#cache = config.mutationCache
    this.#observers = []

    // Merge defaultOptions (lower priority) with per-mutation options (higher
    // priority). The spread means per-mutation keys win where both define the
    // same option.
    this.options = {
      ...config.defaultOptions,
      ...config.options,
    }

    // Mutations default to gcTime = 0 because finished mutations have no
    // caching benefit. updateGcTime() takes the MAX of current and new, so
    // passing 0 effectively means "use 0 unless something else raised it".
    this.updateGcTime(this.options.gcTime ?? 0)

    // Initial idle state — nothing has been executed yet.
    this.state = {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: false,
      status: 'idle',
      variables: undefined,
      submittedAt: 0,
    }
  }

  // ---------------------------------------------------------------------------
  // Observer management
  // ---------------------------------------------------------------------------

  /**
   * Register an observer.
   *
   * Cancels any pending GC timeout because an active observer means this
   * mutation is still being used and must not be removed.
   */
  addObserver(observer: MutationObserverInterface<TData, TError, TVariables, TContext>): void {
    if (!this.#observers.includes(observer)) {
      this.#observers.push(observer)
      // Cancel any pending GC now that someone is watching again.
      this.clearGcTimeout()
    }
  }

  /**
   * Unregister an observer.
   *
   * If this was the last observer, schedule GC so the mutation is removed
   * from the cache after gcTime milliseconds.
   */
  removeObserver(observer: MutationObserverInterface<TData, TError, TVariables, TContext>): void {
    this.#observers = this.#observers.filter((o) => o !== observer)
    if (!this.#observers.length) {
      this.scheduleGc()
    }
  }

  // ---------------------------------------------------------------------------
  // Execution — the heart of the class
  // ---------------------------------------------------------------------------

  /**
   * Execute the mutation with the given variables.
   *
   * Lifecycle, in order:
   *   1. Transition to 'pending', store variables + submittedAt timestamp.
   *   2. Call onMutate (per-mutation, then global) to obtain the context for
   *      optimistic updates.
   *   3. Store context in state via 'setContext' dispatch.
   *   4. Execute mutationFn via Retryer (handles retry logic).
   *      - On each retry failure, dispatch 'failed' to update counters.
   *   5a. SUCCESS: dispatch 'success', then call onSuccess (per-mutation,
   *       then global), then onSettled (per-mutation, then global).
   *   5b. ERROR:   dispatch 'error', then call onError (per-mutation, then
   *       global), then onSettled (per-mutation, then global). Re-throw so
   *       the caller (MutationObserver.mutateAsync) can handle the error.
   *
   * @returns The data returned by a successful mutationFn.
   * @throws  The error thrown by a failed mutationFn (after all retries).
   */
  async execute(variables: TVariables): Promise<TData> {
    // --- Step 1: transition to pending ---
    this.#dispatch({
      type: 'pending',
      variables,
      submittedAt: Date.now(),
    })

    // --- Step 2: call onMutate to produce the optimistic-update context ---
    // The context is critical: onError receives it so it can roll back
    // any optimistic state changes made inside onMutate.
    const context = await this.options.onMutate?.(variables)

    // --- Step 3: store context in state before any async work that can fail ---
    // Storing it here means the context is safely in the serialisable state
    // object before we attempt the network call.
    this.#dispatch({ type: 'setContext', context })

    try {
      // --- Step 4: execute the mutationFn via Retryer ---
      if (!this.options.mutationFn) {
        throw new Error('No mutationFn found')
      }

      // Create and start a Retryer. We pass retry: 0 as the default so
      // mutations do not retry by default (unlike queries which default to 3).
      this.#retryer = new Retryer<TData, TError>({
        fn: () => this.options.mutationFn!(variables),
        onFail: (failureCount, error) => {
          // Update the failure counters in state so observers can show a
          // "retrying…" message.
          this.#dispatch({ type: 'failed', failureCount, error })
        },
        retry: this.options.retry ?? 0,
        retryDelay: this.options.retryDelay,
        networkMode: this.options.networkMode,
      })

      const data = await this.#retryer.start()

      // --- Step 5a: success path ---

      this.#dispatch({ type: 'success', data })

      // Per-mutation success hook — e.g. update the local query cache
      // optimistically or show a success toast.
      await this.options.onSuccess?.(data, variables, context)

      // Global success hook — e.g. invalidate related queries.
      await this.#cache.config.onSuccess?.(data, variables, context, this)

      // Per-mutation settled hook.
      await this.options.onSettled?.(data, null, variables, context)

      // Global settled hook.
      await this.#cache.config.onSettled?.(data, null, variables, context, this)

      return data
    } catch (error) {
      // --- Step 5b: error path ---
      const typedError = error as TError

      this.#dispatch({ type: 'error', error: typedError })

      // Per-mutation error hook — rolls back optimistic updates using context.
      await this.options.onError?.(typedError, variables, context)

      // Global error hook.
      await this.#cache.config.onError?.(typedError, variables, context, this)

      // Per-mutation settled hook (receives undefined data, non-null error).
      await this.options.onSettled?.(undefined, typedError, variables, context)

      // Global settled hook.
      await this.#cache.config.onSettled?.(undefined, typedError, variables, context, this)

      // Re-throw so MutationObserver.mutateAsync() rejects and the caller
      // can handle the error (e.g. show an error boundary or error toast).
      throw typedError
    }
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /**
   * Reset this mutation back to its initial idle state.
   *
   * Called by MutationObserver.reset() so the user can dismiss an error and
   * allow re-submission of the form/action.
   */
  reset(): void {
    this.#dispatch({ type: 'reset' })
  }

  // ---------------------------------------------------------------------------
  // Removable abstract method implementation
  // ---------------------------------------------------------------------------

  /**
   * Called by the GC timeout (scheduled in scheduleGc()) after gcTime ms.
   *
   * Only removes from the cache if there are still no observers — a new
   * subscriber may have arrived during the timeout window.
   */
  protected optionalRemove(): void {
    if (!this.#observers.length) {
      // Cast to the erased-generic form used by the cache boundary interface.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#cache.remove(this as unknown as Mutation<any, any, any, any>)
    }
  }

  // ---------------------------------------------------------------------------
  // Destroy
  // ---------------------------------------------------------------------------

  /**
   * Forcibly clean up this instance.
   *
   * Called by MutationCache.clear() or MutationCache.remove(). Cancels any
   * pending GC timeout via super.destroy() so optionalRemove() never fires
   * after explicit removal.
   */
  destroy(): void {
    super.destroy()
  }

  // ---------------------------------------------------------------------------
  // Private state dispatcher
  // ---------------------------------------------------------------------------

  /**
   * Apply an action to the state machine and notify all subscribers.
   *
   * Two levels of notification:
   *   1. Each registered MutationObserver receives onMutationUpdate(action) so
   *      it can recompute its derived result and schedule a UI re-render.
   *   2. The MutationCache receives a generic 'updated' event so DevTools and
   *      other cache-level subscribers stay in sync.
   *
   * Both are wrapped in notifyManager.batch() so that a single execute() call
   * (which dispatches several actions in sequence) does not produce N separate
   * scheduler ticks — all notifications from the same tick are flushed together
   * for a single React render pass.
   */
  #dispatch(action: MutationAction<TData, TError, TVariables, TContext>): void {
    this.state = reducer(this.state, action)

    notifyManager.batch(() => {
      this.#observers.forEach((observer) => {
        observer.onMutationUpdate(action)
      })
      // Cast to the erased-generic form used by the cache boundary interface.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#cache.notify({ type: 'updated', mutation: this as unknown as Mutation<any, any, any, any>, action })
    })
  }
}
