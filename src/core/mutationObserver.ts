/**
 * mutationObserver.ts
 *
 * Bridges a Mutation (cache entry) and a React component.
 *
 * One MutationObserver is created per useMutation() call. Unlike QueryObserver,
 * there is no caching, staleness, or background refetch — the observer simply
 * reflects the mutation's current state and exposes mutate / mutateAsync.
 *
 * Architecture:
 *   useMutation() → MutationObserver → Mutation (in MutationCache)
 *        ↑                                     |
 *        └──────── onMutationUpdate() ──────────┘
 */

import { Subscribable } from './subscribable'
import { notifyManager } from './notifyManager'
import { Mutation } from './mutation'
import type {
  MutationAction,
  MutationObserverInterface,
} from './mutation'
import type {
  MutationOptions,
  MutationObserverResult,
  MutateOptions,
  QueryKey,
} from './types'

// ---------------------------------------------------------------------------
// Local interfaces (break circular deps)
// ---------------------------------------------------------------------------

interface MutationCacheContract {
  build<TData, TError, TVariables, TContext>(
    client: MutationClientInterface,
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): Mutation<TData, TError, TVariables, TContext>
}

/**
 * The minimal slice of QueryClient that MutationObserver requires.
 * QueryClient satisfies this structurally — no explicit `implements` needed.
 */
export interface MutationClientInterface {
  getMutationCache(): MutationCacheContract
  defaultMutationOptions<TData, TError, TVariables, TContext>(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): MutationOptions<TData, TError, TVariables, TContext>
}

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type MutationObserverListener<TData, TError, TVariables, TContext> = (
  result: MutationObserverResult<TData, TError, TVariables, TContext>,
) => void

// ---------------------------------------------------------------------------
// MutationObserver
// ---------------------------------------------------------------------------

/**
 * Bridges a Mutation (cache entry) and React.
 *
 * Implements MutationObserverInterface so the Mutation can call back into the
 * observer when its state transitions without knowing the concrete type.
 */
export class MutationObserver<
    TData = unknown,
    TError = Error,
    TVariables = unknown,
    TContext = unknown,
  >
  extends Subscribable<MutationObserverListener<TData, TError, TVariables, TContext>>
  implements MutationObserverInterface<TData, TError, TVariables, TContext>
{
  // -------------------------------------------------------------------------
  // Fields
  // -------------------------------------------------------------------------

  /** The mutation instance owned by the cache. */
  #currentMutation!: Mutation<TData, TError, TVariables, TContext>

  /** The last computed result — returned to useMutation via getCurrentResult(). */
  #currentResult!: MutationObserverResult<TData, TError, TVariables, TContext>

  /** Options are set once in the constructor and updated via setOptions(). */
  options: MutationOptions<TData, TError, TVariables, TContext>

  constructor(
    private readonly client: MutationClientInterface,
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ) {
    super()
    this.options = client.defaultMutationOptions(options)
    this.#updateMutation()
    this.#updateResult()
  }

  // -------------------------------------------------------------------------
  // Subscribable lifecycle hooks
  // -------------------------------------------------------------------------

  protected onSubscribe(): void {
    if (this.listeners.size === 1) {
      // First subscriber — register with the mutation so it notifies us
      this.#currentMutation.addObserver(
        this as unknown as MutationObserverInterface<TData, TError, TVariables, TContext>,
      )
    }
  }

  protected onUnsubscribe(): void {
    if (!this.hasListeners()) {
      // Last subscriber gone — detach from the mutation (triggers GC scheduling)
      this.#currentMutation.removeObserver(
        this as unknown as MutationObserverInterface<TData, TError, TVariables, TContext>,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Update options (called by useMutation's useEffect when options change).
   * Merges new options with client defaults and propagates to the mutation.
   */
  setOptions(
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ): void {
    this.options = this.client.defaultMutationOptions(options)
    this.#currentMutation.options = this.options
  }

  /** Returns the current result snapshot — called by useSyncExternalStore. */
  getCurrentResult(): MutationObserverResult<TData, TError, TVariables, TContext> {
    return this.#currentResult
  }

  /**
   * Fire-and-forget mutation trigger.
   *
   * Errors are surfaced via the result object (`isError`, `error`) rather than
   * thrown. Per-call lifecycle hooks (options.onSuccess etc.) are invoked in
   * addition to the mutation-level hooks.
   */
  mutate(
    variables: TVariables,
    options?: MutateOptions<TData, TError, TVariables, TContext>,
  ): void {
    this.#currentMutation.execute(variables).then(
      (data) => {
        options?.onSuccess?.(data, variables, this.#currentMutation.state.context)
        options?.onSettled?.(
          data,
          null,
          variables,
          this.#currentMutation.state.context,
        )
      },
      (error: TError) => {
        options?.onError?.(error, variables, this.#currentMutation.state.context)
        options?.onSettled?.(
          undefined,
          error,
          variables,
          this.#currentMutation.state.context,
        )
      },
    )
  }

  /**
   * Promise-based mutation trigger.
   *
   * Unlike `mutate`, this THROWS on failure — the caller must catch.
   * Returns the resolved data on success.
   */
  mutateAsync(
    variables: TVariables,
    options?: MutateOptions<TData, TError, TVariables, TContext>,
  ): Promise<TData> {
    return this.#currentMutation.execute(variables).then(
      (data) => {
        options?.onSuccess?.(data, variables, this.#currentMutation.state.context)
        options?.onSettled?.(
          data,
          null,
          variables,
          this.#currentMutation.state.context,
        )
        return data
      },
      (error: TError) => {
        options?.onError?.(error, variables, this.#currentMutation.state.context)
        options?.onSettled?.(
          undefined,
          error,
          variables,
          this.#currentMutation.state.context,
        )
        throw error
      },
    )
  }

  /**
   * Reset the mutation back to its idle state.
   * Called by the `reset` function exposed from useMutation().
   */
  reset(): void {
    this.#currentMutation.reset()
  }

  // -------------------------------------------------------------------------
  // MutationObserverInterface implementation
  // -------------------------------------------------------------------------

  /**
   * Called by Mutation.#dispatch() (via notifyManager.batch) after every
   * state transition. Recomputes the result and notifies React listeners.
   */
  onMutationUpdate(
    _action: MutationAction<TData, TError, TVariables, TContext>,
  ): void {
    this.#updateResult()
    notifyManager.batch(() => {
      this.listeners.forEach((listener) => listener(this.#currentResult))
    })
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build (or retrieve) the mutation instance from the cache.
   * Called once in the constructor — mutations are not reused across setOptions.
   */
  #updateMutation(): void {
    const cache = this.client.getMutationCache()
    this.#currentMutation = cache.build<TData, TError, TVariables, TContext>(
      this.client,
      this.options,
    )
  }

  /**
   * Recompute the rich result object from the mutation's raw state.
   *
   * All boolean flags are derived from `status` — they are provided as
   * conveniences so calling code doesn't need to compare strings.
   */
  #updateResult(): void {
    const state = this.#currentMutation.state
    const mutate = this.mutate.bind(this)
    const mutateAsync = this.mutateAsync.bind(this)
    const reset = this.reset.bind(this)

    this.#currentResult = {
      // --- Spread raw state ---
      context: state.context,
      data: state.data,
      error: state.error,
      failureCount: state.failureCount,
      failureReason: state.failureReason,
      isPaused: state.isPaused,
      status: state.status,
      variables: state.variables,
      submittedAt: state.submittedAt,
      // --- Derived booleans ---
      isError: state.status === 'error',
      isIdle: state.status === 'idle',
      isPending: state.status === 'pending',
      isSuccess: state.status === 'success',
      // --- Callable functions ---
      mutate,
      mutateAsync,
      reset,
    }
  }
}

// ---------------------------------------------------------------------------
// Re-export MutationClientInterface so the React layer can import it from here
// ---------------------------------------------------------------------------
export type { MutationOptions, MutateOptions, QueryKey }
