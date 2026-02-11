/**
 * onlineManager.ts
 *
 * Singleton that tracks network online/offline status.
 *
 * Used in two places:
 * 1. canFetch() in retryer.ts reads navigator.onLine to decide whether a
 *    fetch attempt is allowed to proceed.
 * 2. QueryObserver subscribes here to resume paused fetches when the network
 *    reconnects (the `refetchOnReconnect` feature).
 *
 * Design notes:
 * - Structurally identical to FocusManager but for 'online'/'offline' events.
 * - The DOM event listeners are set up lazily via setup(), which
 *   QueryClient.mount() calls once.
 * - isOnline() reads navigator.onLine directly for a fresh, synchronous value.
 * - getOnlineStatus() returns the last value delivered by an event, which may
 *   differ from navigator.onLine if setup() has not been called yet (defaults
 *   to true).
 * - setOnline() lets tests override the connectivity state without touching
 *   the DOM or navigator.
 */

import { Subscribable } from './subscribable'
import { isServer } from './utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback signature delivered to OnlineManager subscribers. */
type OnlineListener = (online: boolean) => void

/**
 * Optional custom setup function signature.
 *
 * Receives a callback (`onOnline`) that must be called whenever connectivity
 * is restored. Returns a cleanup function that removes the custom listener.
 *
 * Useful in environments without standard DOM events (e.g. React Native's
 * NetInfo, Node.js network monitoring).
 */
type SetupFn = (onOnline: () => void) => () => void

// ---------------------------------------------------------------------------
// OnlineManager
// ---------------------------------------------------------------------------

class OnlineManager extends Subscribable<OnlineListener> {
  /**
   * Last known online state. Defaults to `true` so that before any DOM events
   * fire the app behaves as though it is online (avoids unnecessarily pausing
   * fetches on initial load).
   */
  #online: boolean = true

  /**
   * Cleanup function returned by the current setup. Called before re-setup
   * and on teardown.
   */
  #cleanup?: () => void

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  /**
   * Wire up the online/offline event listeners. Typically called once by
   * QueryClient.mount().
   *
   * @param setupFn - Optional custom setup function. If omitted, the default
   *   browser `window.online` / `window.offline` listeners are used. Ignored
   *   in SSR environments.
   * @returns A cleanup function that removes the listener(s).
   */
  setup(setupFn?: SetupFn): () => void {
    // Remove any previously registered listener before installing a new one.
    this.#cleanup?.()
    this.#cleanup = undefined

    if (setupFn) {
      // Custom environment: delegate entirely to the caller-provided function.
      // The custom setup only needs to signal "came back online", so we call
      // setOnline(true). For a full custom solution the caller can also call
      // setOnline(false) directly when connectivity drops.
      this.#cleanup = setupFn(() => this.setOnline(true))
      return this.#cleanup
    }

    if (!isServer) {
      // Default browser implementation.
      const onlineListener = (): void => {
        this.setOnline(true)
      }
      const offlineListener = (): void => {
        this.setOnline(false)
      }

      window.addEventListener('online', onlineListener, false)
      window.addEventListener('offline', offlineListener, false)

      this.#cleanup = (): void => {
        window.removeEventListener('online', onlineListener, false)
        window.removeEventListener('offline', offlineListener, false)
      }
    }

    return this.#cleanup ?? (() => {})
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  /**
   * Synchronously read the browser's current online state from navigator.onLine.
   *
   * This is the authoritative read used by canFetch() in retryer.ts. It
   * bypasses the cached `#online` field so it always reflects the latest
   * network state even before setup() has been called.
   *
   * Returns `true` on the server (where `navigator` is undefined) so that SSR
   * fetches are never blocked by a missing network state.
   */
  isOnline(): boolean {
    if (typeof navigator === 'undefined') {
      // Server-side: treat as online.
      return true
    }
    return navigator.onLine
  }

  /**
   * Return the last value broadcast through setOnline().
   *
   * Useful for consumers that want the event-driven value rather than the
   * live navigator.onLine property (e.g. for comparing previous vs current).
   * Defaults to `true` if setOnline() has never been called.
   */
  getOnlineStatus(): boolean {
    return this.#online
  }

  // ---------------------------------------------------------------------------
  // Write API
  // ---------------------------------------------------------------------------

  /**
   * Update the cached online state and notify all subscribers.
   *
   * Called internally by the 'online'/'offline' event listeners and by the
   * optional custom setup function. Can also be called directly from tests
   * to simulate connectivity changes.
   */
  setOnline(online: boolean): void {
    this.#online = online
    this.listeners.forEach((listener) => {
      listener(online)
    })
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The single shared OnlineManager instance.
 * Import this directly — do not instantiate OnlineManager yourself.
 */
export const onlineManager = new OnlineManager()
