/**
 * subscribable.ts
 *
 * Base class for the observer pattern used throughout the system.
 *
 * Every observable entity — QueryCache, MutationCache, QueryObserver,
 * MutationObserver, FocusManager, OnlineManager — extends Subscribable.
 *
 * Design decisions:
 * - Listeners are stored in a Set, giving O(1) add/remove and automatic
 *   deduplication (subscribing the same function twice is a no-op for the Set).
 * - subscribe() returns an unsubscribe function, following the cleanup pattern
 *   used by React.useEffect, EventTarget.addEventListener wrappers, and
 *   virtually every modern reactive primitive.
 * - onSubscribe / onUnsubscribe are protected hooks that subclasses can
 *   override to start/stop side-effects (e.g. adding window event listeners,
 *   scheduling interval refetches) only while there is at least one listener.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export class Subscribable<TListener extends Function = () => void> {
  /** The set of currently registered listener functions. */
  protected listeners: Set<TListener>

  constructor() {
    this.listeners = new Set<TListener>()
    // Bind subscribe so it can be passed as a callback without losing `this`
    // (mirrors how useSyncExternalStore expects a stable subscribe reference).
    this.subscribe = this.subscribe.bind(this)
  }

  /**
   * Register a listener. The listener will be called whenever this observable
   * notifies its subscribers.
   *
   * @returns An unsubscribe function. Call it to stop receiving notifications
   *          and trigger the onUnsubscribe hook.
   */
  subscribe(listener: TListener): () => void {
    this.listeners.add(listener)
    this.onSubscribe()

    return () => {
      this.listeners.delete(listener)
      this.onUnsubscribe()
    }
  }

  /**
   * Returns true if there is at least one active listener.
   *
   * Used by Query / Mutation to decide whether to schedule GC (only when
   * inactive, i.e. no listeners) and by QueryCache to avoid unnecessary work.
   */
  hasListeners(): boolean {
    return this.listeners.size > 0
  }

  /**
   * Called every time a new listener is added via subscribe().
   *
   * Override in subclasses to perform setup work that should only happen
   * while the observable is "active" (has subscribers).
   *
   * Common use cases:
   * - Start a refetch interval when the first observer mounts
   * - Add a window 'focus' event listener
   * - Begin an online/offline network monitor
   */
  protected onSubscribe(): void {
    // No-op by default — subclasses opt in by overriding
  }

  /**
   * Called every time a listener is removed via the unsubscribe function.
   *
   * Override in subclasses to perform teardown work once no more listeners
   * are interested (e.g. clear a refetch interval, remove event listeners,
   * schedule GC for the underlying query data).
   *
   * Note: this fires on EVERY removal, not just the last one. Subclasses
   * should check `!this.hasListeners()` if they only want to react to the
   * transition from active → inactive.
   */
  protected onUnsubscribe(): void {
    // No-op by default — subclasses opt in by overriding
  }
}
