/**
 * removable.ts
 *
 * Abstract base class for objects that can be garbage-collected from the cache
 * after a configurable idle period (gcTime).
 *
 * Who extends this:
 *   - Query  — removed from QueryCache when all observers unsubscribe and
 *              gcTime elapses
 *   - Mutation — removed from MutationCache once settled and gcTime elapses
 *
 * Why deferred GC instead of immediate removal:
 *   If a user navigates away from a page and quickly navigates back, the query
 *   data is still in memory and can be shown instantly while a background
 *   refetch occurs. This is one of the key UX features of TanStack Query.
 *   The gcTime window (default 5 minutes) controls how long this "fast
 *   navigation" benefit is available.
 *
 * Lifecycle:
 *   1. Last observer unsubscribes → subclass calls scheduleGc()
 *   2. gcTime ms later → gcTimeout fires → optionalRemove() is called
 *   3. optionalRemove() checks whether it is still safe to remove (e.g. no
 *      new observer subscribed in the meantime) and removes from the cache
 *   4. If a new observer subscribes before the timeout fires, the subclass
 *      calls clearGcTimeout() to cancel the pending removal
 */

import { isValidTimeout } from './utils'

export abstract class Removable {
  /**
   * How long (ms) to keep this object in cache after it becomes inactive
   * (no observers). Managed by updateGcTime().
   *
   * Defaults:
   *   - Browser : 5 minutes (5 * 60 * 1000)
   *   - Server  : Infinity (to avoid GC during SSR rendering)
   */
  gcTime!: number

  /** The pending setTimeout handle for the scheduled GC, or undefined. */
  private gcTimeout?: ReturnType<typeof setTimeout>

  /**
   * Clean up resources held by this instance.
   *
   * Called when the object is being forcibly removed from the cache
   * (e.g. queryClient.clear() or queryClient.removeQueries()).
   * Cancels any pending GC timeout so the optionalRemove callback never fires.
   */
  destroy(): void {
    this.clearGcTimeout()
  }

  /**
   * Start (or restart) the GC countdown.
   *
   * Cancels any existing pending timeout first, then sets a new one for
   * `this.gcTime` milliseconds. When it fires, optionalRemove() is called.
   *
   * If gcTime is not a valid finite positive number (e.g. Infinity), no
   * timeout is set and the object stays in memory indefinitely — which is the
   * correct behaviour for SSR environments where we never want GC.
   *
   * Subclasses call this inside onUnsubscribe() once hasListeners() is false.
   */
  protected scheduleGc(): void {
    this.clearGcTimeout()
    if (isValidTimeout(this.gcTime)) {
      this.gcTimeout = setTimeout(() => {
        this.optionalRemove()
      }, this.gcTime)
    }
  }

  /**
   * Update gcTime to be the maximum of its current value and `newGcTime`.
   *
   * We always take the maximum because multiple observers may configure
   * different gcTimes — we want to honour the most conservative (longest)
   * one so data is not evicted while any observer still expects it to be
   * available.
   *
   * @param newGcTime - Proposed new gcTime, or undefined to use the default.
   *
   * Default values:
   *   - Server  : Infinity (never GC during SSR)
   *   - Browser : 5 * 60 * 1000 ms (5 minutes)
   */
  protected updateGcTime(newGcTime: number | undefined): void {
    this.gcTime = Math.max(
      this.gcTime || 0,
      newGcTime ?? (typeof window === 'undefined' ? Infinity : 5 * 60 * 1000),
    )
  }

  /**
   * Cancel any pending GC timeout.
   *
   * Called when:
   *   - A new observer subscribes (we no longer want to remove this object)
   *   - destroy() is called (force removal, skip deferred GC)
   *   - scheduleGc() is called (restart the countdown from zero)
   */
  protected clearGcTimeout(): void {
    if (this.gcTimeout !== undefined) {
      clearTimeout(this.gcTimeout)
      this.gcTimeout = undefined
    }
  }

  /**
   * Remove this instance from its parent cache if it is still safe to do so.
   *
   * Called by the GC timeout. Subclasses must implement this and typically
   * check `!this.hasListeners()` before actually calling the cache's remove
   * method — a new subscriber may have arrived during the timeout window.
   *
   * @example (Query implementation)
   * protected optionalRemove(): void {
   *   if (!this.hasListeners()) {
   *     this.#cache.remove(this)
   *   }
   * }
   */
  protected abstract optionalRemove(): void
}
