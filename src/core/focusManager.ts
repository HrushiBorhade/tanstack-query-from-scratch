/**
 * focusManager.ts
 *
 * Singleton that tracks whether the browser tab/window has focus.
 *
 * QueryObserver subscribes to this singleton to trigger refetches when the
 * user returns to the tab (the `refetchOnWindowFocus` feature).
 *
 * Design notes:
 * - Extends Subscribable so any number of QueryObserver instances can listen
 *   without each registering its own DOM event listener.
 * - The underlying DOM event listener is set up lazily via setup(), which
 *   QueryClient.mount() calls once. Until then the manager is passive.
 * - isFocused() is the synchronous read path used by Query to decide whether
 *   to trigger a refetch at the moment a query result arrives.
 * - setFocused() lets tests and custom environments override the focus state
 *   without touching the DOM.
 */

import { Subscribable } from './subscribable'
import { isServer } from './utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback signature delivered to FocusManager subscribers. */
type FocusListener = (focused: boolean) => void

/**
 * Optional custom setup function signature.
 *
 * Receives a callback (`onFocus`) that must be called whenever focus is
 * gained. Returns a cleanup function that removes the custom listener.
 *
 * Useful in environments without a standard DOM (e.g. React Native, SSR with
 * custom focus detection).
 */
type SetupFn = (onFocus: () => void) => () => void

// ---------------------------------------------------------------------------
// FocusManager
// ---------------------------------------------------------------------------

class FocusManager extends Subscribable<FocusListener> {
  /**
   * Last known focus state. Defaults to `undefined` so that isFocused()
   * falls back to reading from the DOM. Only set when setFocused() is
   * called explicitly (tests, custom environments) or when a DOM event fires.
   */
  #focused: boolean | undefined = undefined

  /**
   * Cleanup function returned by the current setup (either the custom one
   * provided via setup() or the default visibilitychange listener).
   * Called before re-setup and on teardown.
   */
  #cleanup?: () => void

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  /**
   * Wire up the focus event listener. Typically called once by QueryClient.mount().
   *
   * @param setupFn - Optional custom setup function. If omitted, the default
   *   browser `visibilitychange` listener is used. Ignored in SSR environments.
   * @returns A cleanup function that removes the listener.
   */
  setup(setupFn?: SetupFn): () => void {
    // Remove any previously registered listener before installing a new one.
    this.#cleanup?.()
    this.#cleanup = undefined

    if (setupFn) {
      // Custom environment: delegate entirely to the caller-provided function.
      this.#cleanup = setupFn(() => this.#notify(true))
      return this.#cleanup
    }

    if (!isServer) {
      // Default browser implementation: use the Page Visibility API.
      // visibilitychange fires on tab switch, window minimize, etc.
      const listener = (): void => {
        this.#notify(document.visibilityState !== 'hidden')
      }

      window.addEventListener('visibilitychange', listener, false)

      this.#cleanup = (): void => {
        window.removeEventListener('visibilitychange', listener, false)
      }
    }

    return this.#cleanup ?? (() => {})
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  /**
   * Synchronously determine whether the document is currently focused.
   *
   * Uses the Page Visibility API when available so that minimised windows and
   * background tabs are correctly treated as "not focused".
   *
   * Falls back to `true` on the server (where `document` is undefined) so that
   * SSR fetches are never blocked by a missing focus state.
   */
  isFocused(): boolean {
    // If setFocused() was called explicitly, use the stored value.
    if (this.#focused !== undefined) return this.#focused
    if (typeof document === 'undefined') {
      // Server-side: treat as focused so SSR fetches always proceed.
      return true
    }
    return document.visibilityState !== 'hidden'
  }

  // ---------------------------------------------------------------------------
  // Write API
  // ---------------------------------------------------------------------------

  /**
   * Manually override the focus state.
   *
   * Primarily intended for:
   * 1. Tests — assert specific focus scenarios without touching the DOM.
   * 2. Custom environments (React Native, Electron) where visibility is
   *    determined by app-level events rather than browser visibility.
   */
  setFocused(focused: boolean): void {
    this.#notify(focused)
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Update internal state and broadcast to all subscribers.
   */
  #notify(focused: boolean): void {
    this.#focused = focused
    this.listeners.forEach((listener) => {
      listener(focused)
    })
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The single shared FocusManager instance.
 * Import this directly — do not instantiate FocusManager yourself.
 */
export const focusManager = new FocusManager()
