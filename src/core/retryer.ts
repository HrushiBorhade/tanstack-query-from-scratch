/**
 * retryer.ts
 *
 * The retry engine for TanStack Query.
 *
 * A Retryer wraps a single async operation (the "fetch function") and owns
 * the entire lifecycle: initial attempt, exponential-backoff retries, offline
 * pausing, and cancellation. Callers `await retryer.promise` to get the
 * resolved value or a final rejection.
 *
 * Key design decisions:
 * - The public `promise` is created once in the constructor so callers can
 *   attach `.then` / `.catch` handlers before `start()` is called.
 * - Private native fields (`#`) prevent accidental external mutation.
 * - The inner `run()` recursive async function keeps the retry loop simple
 *   and avoids any `while(true)` constructs that would obscure control flow.
 * - Cancellation is checked at every `await` boundary (before fetch, after
 *   delay) to minimise the window where work continues after cancel().
 */

import { isServer } from './utils'

// ---------------------------------------------------------------------------
// Public config type
// ---------------------------------------------------------------------------

export interface RetryerConfig<TData = unknown, TError = Error> {
  /** The async operation to attempt (and retry). */
  fn: () => TData | Promise<TData>
  /**
   * An optional already-in-flight promise. When provided, the Retryer will
   * await it as the first attempt instead of calling `fn` directly.
   * Used by Query to hand off a pending initialPromise without restarting.
   */
  initialPromise?: Promise<TData>
  /** Abort the underlying network request on cancel(). */
  abort?: () => void
  /** Called with the final error when all retries are exhausted. */
  onError?: (error: TError) => void
  /** Called with the data when the fetch ultimately succeeds. */
  onSuccess?: (data: TData) => void
  /**
   * Called after each failed attempt with the current failure count and error.
   * Note: called AFTER incrementing failureCount, so count starts at 1.
   */
  onFail?: (failureCount: number, error: TError) => void
  /** Called when the Retryer pauses because the network is offline. */
  onPause?: () => void
  /** Called when the Retryer resumes after being paused. */
  onContinue?: () => void
  /** Retry policy — same semantics as QueryOptions.retry. Defaults to 3. */
  retry?: boolean | number | ((failureCount: number, error: TError) => boolean)
  /** Retry delay policy — same semantics as QueryOptions.retryDelay. */
  retryDelay?: number | ((retryAttempt: number, error: TError) => number)
  /** Network mode — controls when fetches are allowed. */
  networkMode?: 'online' | 'always' | 'offlineFirst'
}

// ---------------------------------------------------------------------------
// canFetch
// ---------------------------------------------------------------------------

/**
 * Returns true when a fetch is allowed to proceed given the current network
 * mode and the browser's reported online state.
 *
 * - 'always'      : always allowed, regardless of navigator.onLine
 * - 'online'      : only when navigator.onLine is true (or undefined, i.e. SSR)
 * - 'offlineFirst': same as 'online' for the initial check; retries may pause
 */
export function canFetch(networkMode?: 'online' | 'always' | 'offlineFirst'): boolean {
  if ((networkMode ?? 'online') === 'always') return true
  // Both 'online' and 'offlineFirst' require the network to be reachable.
  // On SSR `navigator` is undefined — treat as online so SSR always proceeds.
  return typeof navigator === 'undefined' || navigator.onLine
}

// ---------------------------------------------------------------------------
// Default retry helpers
// ---------------------------------------------------------------------------

function defaultRetryDelayFn(failureCount: number): number {
  // Exponential backoff starting at 1 s, capped at 30 s.
  // failureCount 1 → 2000 ms, 2 → 4000 ms, 3 → 8000 ms … max 30 000 ms
  return Math.min(1000 * 2 ** failureCount, 30_000)
}

function resolveRetry<TData, TError>(
  retry: RetryerConfig<TData, TError>['retry'],
  failureCount: number,
  error: TError,
): boolean {
  // Server default: 0 retries to avoid hanging SSR renders.
  const defaultRetry = isServer ? 0 : 3
  const value = retry ?? defaultRetry
  if (typeof value === 'function') return value(failureCount, error)
  if (typeof value === 'boolean') return value
  return failureCount < value
}

function resolveRetryDelay<TData, TError>(
  retryDelay: RetryerConfig<TData, TError>['retryDelay'],
  failureCount: number,
  error: TError,
): number {
  const value = retryDelay ?? defaultRetryDelayFn
  if (typeof value === 'function') return value(failureCount, error)
  return value
}

// ---------------------------------------------------------------------------
// Retryer
// ---------------------------------------------------------------------------

export class Retryer<TData = unknown, TError = Error> {
  /**
   * The single awaitable result of this fetch/retry sequence.
   * Created in the constructor so it can be observed before start() is called.
   */
  readonly promise: Promise<TData>

  // The resolve/reject handles for `promise`, captured from the Promise
  // constructor callback. `!` assertions are safe because the callback runs
  // synchronously before the constructor body continues.
  #resolve!: (data: TData) => void
  #reject!: (error: TError) => void

  /**
   * Backing field for the lifecycle status.
   * Widened to `string` so that TypeScript's control-flow narrowing inside
   * async methods cannot eliminate 'cancelled' from the union — `cancel()` can
   * write 'cancelled' at any `await` boundary and the compiler cannot see that
   * from within `#run()`. The public `status()` accessor restores the proper
   * union type for external callers.
   */
  #status: string = 'idle'

  /** How many fetch attempts have failed so far in this sequence. */
  #failureCount: number

  /**
   * True while the retry delay timer is running.
   * Lets external callers (e.g. tests) know the Retryer is sleeping between
   * attempts rather than actively fetching.
   */
  #isRetryScheduled: boolean

  #config: RetryerConfig<TData, TError>

  /**
   * Calling this cancels the underlying network request.
   * Set when entering the fetch, cleared when leaving it.
   */
  #cancelFn?: () => void

  /**
   * Resolves the internal "wait" promise that the retry loop is blocked on.
   * Used in two situations:
   * 1. Waking the loop from an offline pause (called by continue()).
   * 2. Short-circuiting the retry delay (called by cancel()).
   */
  #continueFn?: () => void

  constructor(config: RetryerConfig<TData, TError>) {
    this.#config = config
    this.#failureCount = 0
    this.#isRetryScheduled = false

    this.promise = new Promise<TData>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Resume a paused fetch. Called externally (e.g. by OnlineManager) when the
   * network comes back online.
   *
   * Returns `this.promise` so callers can conveniently `await retryer.continue()`.
   */
  continue(): Promise<unknown> {
    this.#continueFn?.()
    return this.promise
  }

  /**
   * Cancel the in-progress fetch/retry loop.
   *
   * @param cancelOptions.silent - If true, do NOT reject the public promise.
   *   The promise will simply never settle. Use when the caller handles cleanup
   *   separately (e.g. a component unmount where we just want to stop).
   * @param cancelOptions.revert - Reserved for future use (not currently acted upon).
   */
  cancel(cancelOptions?: { silent?: boolean; revert?: boolean }): void {
    if (this.#status === 'resolved') return

    this.#status = 'cancelled'

    // Wake up any sleeping `await` in the retry loop so it exits promptly.
    this.#continueFn?.()

    // Abort the in-flight network request if possible.
    this.#cancelFn?.()
    this.#config.abort?.()

    if (!cancelOptions?.silent) {
      const cancelError = new Error('CancelledError') as unknown as TError
      this.#reject(cancelError)
    }
  }

  /** Current lifecycle status of this Retryer. */
  status(): 'idle' | 'running' | 'cancelled' | 'rejected' | 'resolved' {
    return this.#status as 'idle' | 'running' | 'cancelled' | 'rejected' | 'resolved'
  }

  /** Current failure count. */
  failureCount(): number {
    return this.#failureCount
  }

  /** True while the Retryer is sleeping between retry attempts. */
  isRetryScheduled(): boolean {
    return this.#isRetryScheduled
  }

  // ---------------------------------------------------------------------------
  // Core fetch/retry loop
  // ---------------------------------------------------------------------------

  /**
   * Kick off the fetch/retry loop.
   *
   * Returns `this.promise` so callers can either `await start()` directly or
   * keep a reference to `retryer.promise` — both resolve to the same value.
   */
  async start(): Promise<TData> {
    this.#status = 'running'

    // If the caller handed us an already-in-flight promise (initialPromise),
    // treat its outcome as the first attempt without calling fn() again.
    if (this.#config.initialPromise) {
      try {
        const data = await this.#config.initialPromise
        // Success on the initialPromise — skip the retry loop entirely.
        this.#status = 'resolved'
        this.#config.onSuccess?.(data)
        this.#resolve(data)
        return this.promise
      } catch (error) {
        // Fall through to the normal retry loop starting from failureCount 0.
        // We do NOT increment failureCount here because `run()` will do so on
        // its first error.
        void error // acknowledged
      }
    }

    await this.#run()
    return this.promise
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * The recursive async function that performs one attempt and schedules the
   * next one (via recursive call) if it fails and retries remain.
   */
  async #run(): Promise<void> {
    // --- Checkpoint: cancelled before we even try ---
    if (this.#status === 'cancelled') {
      // `cancel()` already called #reject, so just return.
      return
    }

    // --- Checkpoint: wait for network if offline ---
    if (!canFetch(this.#config.networkMode)) {
      this.#config.onPause?.()
      await this.#waitForContinue()
      // If we were cancelled while waiting, stop.
      if (this.#status === 'cancelled') return
      this.#config.onContinue?.()
    }

    // --- Attempt the fetch ---
    let data: TData
    try {
      data = await this.#config.fn()
    } catch (error) {
      // If we were cancelled mid-fetch, stop without further retry logic.
      if (this.#status === 'cancelled') return

      const typedError = error as TError
      const shouldRetry = resolveRetry<TData, TError>(
        this.#config.retry,
        this.#failureCount,
        typedError,
      )

      if (!shouldRetry) {
        // All retries exhausted — surface the error.
        this.#status = 'rejected'
        this.#config.onError?.(typedError)
        this.#reject(typedError)
        return
      }

      // Record the failure.
      this.#failureCount++
      this.#config.onFail?.(this.#failureCount, typedError)

      // --- Sleep for the retry delay ---
      const delay = resolveRetryDelay<TData, TError>(
        this.#config.retryDelay,
        this.#failureCount,
        typedError,
      )

      this.#isRetryScheduled = true
      await this.#sleep(delay)
      this.#isRetryScheduled = false

      // If we were cancelled during the sleep, stop.
      if (this.#status === 'cancelled') return

      // --- After delay: re-check network for 'online' / 'offlineFirst' ---
      if (!canFetch(this.#config.networkMode)) {
        this.#config.onPause?.()
        await this.#waitForContinue()
        if (this.#status === 'cancelled') return
        this.#config.onContinue?.()
      }

      // Recurse for the next attempt.
      await this.#run()
      return
    }

    // --- Success ---
    this.#status = 'resolved'
    this.#config.onSuccess?.(data)
    this.#resolve(data)
  }

  /**
   * Pause the retry loop until `continue()` is called externally.
   * Does NOT call onPause/onContinue — callers do that around this method.
   */
  #waitForContinue(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#continueFn = resolve
    })
  }

  /**
   * Sleep for `ms` milliseconds.
   *
   * Unlike a plain `setTimeout` promise, this version is cancellable: calling
   * `cancel()` invokes `#continueFn`, which wakes the sleep immediately so the
   * retry loop can exit at its next checkpoint. Also stores `#cancelFn` so
   * that cancel() can clear the timeout and avoid keeping it alive after an
   * early wakeup.
   */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      // Allow continue() / cancel() to wake this sleep early.
      this.#continueFn = resolve

      const timeoutId = setTimeout(() => {
        this.#cancelFn = undefined
        resolve()
      }, ms)

      // Allow cancel() to clear the timer so Node/browser GC isn't blocked.
      this.#cancelFn = () => {
        clearTimeout(timeoutId)
        this.#cancelFn = undefined
        resolve()
      }
    })
  }
}
