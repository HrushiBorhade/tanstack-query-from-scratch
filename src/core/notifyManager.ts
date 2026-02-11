/**
 * notifyManager.ts
 *
 * A singleton that batches and schedules all observer notifications to prevent
 * render cascades in React (and other UI frameworks).
 *
 * Problem it solves:
 *   When a fetch completes, the QueryCache may need to notify dozens of
 *   QueryObservers, each of which triggers a React state update. Without
 *   batching, React would re-render the component tree once per observer.
 *   With batching, all notifications from a single event (fetch complete,
 *   invalidation, etc.) are collected into a queue and flushed together,
 *   resulting in a single reconciliation pass.
 *
 * How it works:
 *   1. Callers open a "transaction" via batch(callback).
 *   2. Inside the transaction, schedule(fn) pushes notifications onto a queue
 *      instead of executing them immediately.
 *   3. When the outermost batch() returns, flush() drains the queue inside
 *      a scheduleFn (default: setTimeout 0) so it runs after the current
 *      synchronous call stack completes.
 *   4. The React adapter replaces batchNotifyFn with React's own batch
 *      mechanism (unstable_batchedUpdates / flushSync) so all state updates
 *      within the flush are collapsed into one render.
 *
 * Customisation points:
 *   - setScheduler()         – replace setTimeout with a custom scheduler
 *   - setNotifyFunction()    – wrap individual notification calls
 *   - setBatchNotifyFunction() – wrap the entire flush (used by React adapter)
 */

type NotifyCallback = () => void
type NotifyFunction = (callback: NotifyCallback) => void
type BatchNotifyFunction = (callback: NotifyCallback) => void

function createNotifyManager() {
  /** Pending callbacks accumulated while a transaction is open. */
  let queue: NotifyCallback[] = []

  /**
   * Nesting depth of open batch() calls. The queue is only flushed when this
   * drops back to zero, supporting nested batch() calls safely.
   */
  let transactions = 0

  /**
   * Wraps each individual notification callback.
   * Default: pass-through (call the callback directly).
   * Replaced by the React adapter with a wrapper that records which
   * listeners were notified (useful for DevTools).
   */
  let notifyFn: NotifyFunction = (callback) => callback()

  /**
   * Wraps the entire flush pass.
   * Default: pass-through.
   * Replaced by the React adapter with React's batching primitive so all
   * state updates within one flush produce a single re-render.
   */
  let batchNotifyFn: BatchNotifyFunction = (callback) => callback()

  /**
   * Controls WHEN the queue is drained after a transaction closes.
   * Default: macrotask (setTimeout 0) — runs after the current call stack
   * and any microtasks (Promise chains) complete.
   * Can be replaced with queueMicrotask, requestAnimationFrame, etc.
   */
  let scheduleFn: (callback: NotifyCallback) => void = (cb) => setTimeout(cb, 0)

  /**
   * Drain the notification queue.
   *
   * Takes a snapshot of the current queue (so any notifications scheduled
   * during the flush do not run in the same pass — they'll be queued for
   * the next flush), then schedules the snapshot to run inside batchNotifyFn
   * so the framework can collapse the resulting state updates.
   */
  function flush(): void {
    const localQueue = queue
    queue = []
    scheduleFn(() => {
      batchNotifyFn(() => {
        localQueue.forEach((callback) => {
          notifyFn(callback)
        })
      })
    })
  }

  /**
   * Open a notification transaction.
   *
   * All schedule() calls made synchronously inside `callback` will be queued
   * rather than executed immediately. The queue is flushed when the outermost
   * batch() completes.
   *
   * Supports nesting: inner batch() calls simply increment/decrement the
   * transaction counter without triggering an additional flush.
   *
   * @returns The return value of `callback`.
   */
  function batch<T>(callback: () => T): T {
    let result: T
    transactions++
    try {
      result = callback()
    } finally {
      transactions--
      if (!transactions) {
        flush()
      }
    }
    return result!
  }

  /**
   * Schedule a notification callback for deferred execution.
   *
   * - If we are inside a batch() transaction, push onto the queue.
   * - Otherwise, execute immediately via the scheduler / batch wrapper
   *   (mirrors behaviour of an ad-hoc single-item flush).
   */
  function schedule(callback: NotifyCallback): void {
    if (transactions) {
      queue.push(callback)
    } else {
      scheduleFn(() => {
        batchNotifyFn(() => {
          notifyFn(callback)
        })
      })
    }
  }

  /**
   * Wrap a callback so that every invocation is automatically scheduled
   * through the notification manager rather than called synchronously.
   *
   * Primary use case: wrap the `onStoreChange` callback passed to
   * React's `useSyncExternalStore` so that cache updates trigger a batched
   * React re-render instead of individual synchronous renders.
   *
   * @example
   * const stableOnChange = notifyManager.batchCalls(onStoreChange)
   * cache.subscribe(stableOnChange)
   */
  function batchCalls<T extends (...args: Array<unknown>) => unknown>(
    callback: T,
  ): T {
    return ((...args: Parameters<T>) => {
      schedule(() => {
        callback(...args)
      })
    }) as T
  }

  /**
   * Replace the per-notification wrapper function.
   *
   * Called by the React adapter to install instrumentation (e.g. DevTools
   * tracking) around each individual observer notification.
   */
  function setNotifyFunction(fn: NotifyFunction): void {
    notifyFn = fn
  }

  /**
   * Replace the batch-flush wrapper function.
   *
   * Called by the React adapter to install React's own batching primitive
   * (e.g. `ReactDOM.unstable_batchedUpdates`) so all state updates produced
   * during a single flush result in a single React render pass.
   */
  function setBatchNotifyFunction(fn: BatchNotifyFunction): void {
    batchNotifyFn = fn
  }

  /**
   * Replace the scheduler that controls when a flushed queue actually runs.
   *
   * The default `setTimeout(cb, 0)` defers execution to the next macrotask,
   * which is appropriate for most cases. You might replace this with
   * `queueMicrotask` for tighter scheduling or a custom scheduler for tests.
   */
  function setScheduler(fn: (callback: NotifyCallback) => void): void {
    scheduleFn = fn
  }

  return {
    batch,
    batchCalls,
    flush,
    schedule,
    setNotifyFunction,
    setBatchNotifyFunction,
    setScheduler,
  }
}

/**
 * The global singleton NotifyManager instance.
 *
 * Every part of the system that needs to notify observers should go through
 * this manager so that batching is applied consistently.
 *
 * The React adapter calls `notifyManager.setBatchNotifyFunction` once at
 * startup to plug in React's batching mechanism.
 */
export const notifyManager = createNotifyManager()
