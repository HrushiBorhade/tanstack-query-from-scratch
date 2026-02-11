/**
 * utils.ts
 *
 * Pure, side-effect-free utility functions shared across the core system.
 * Nothing in this file should import from other project files — it is the
 * lowest layer of the dependency graph.
 */

import type { QueryKey, QueryHash } from './types'

// ---------------------------------------------------------------------------
// Environment Detection
// ---------------------------------------------------------------------------

/**
 * True when running in a server-side (SSR / Node.js) environment where the
 * `window` global is not available. Used to adjust default timeouts and to
 * skip browser-only event listeners.
 */
export const isServer = typeof window === 'undefined'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` is a finite, non-negative number suitable for use
 * as a setTimeout / gcTime / staleTime duration.
 *
 * Explicitly rejects:
 * - Infinity (setTimeout(fn, Infinity) fires immediately in some engines)
 * - Negative numbers
 * - Non-numbers (undefined, null, strings, etc.)
 */
export function isValidTimeout(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value !== Infinity
}

// ---------------------------------------------------------------------------
// Query Key Hashing
// ---------------------------------------------------------------------------

/**
 * Produces a stable JSON string from any query key array.
 *
 * Key properties:
 * - Plain-object values have their keys sorted before serialisation, so
 *   `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same hash.
 * - Non-plain objects (class instances, arrays) are left as-is.
 * - The result is suitable for use as a Map / object key.
 *
 * @example
 * hashQueryKey(['users', { role: 'admin', page: 1 }])
 * // => '["users",{"page":1,"role":"admin"}]'
 */
export function hashQueryKey(queryKey: QueryKey): QueryHash {
  return JSON.stringify(queryKey, (_key, val) => {
    if (isPlainObject(val)) {
      // Sort keys to ensure deterministic serialisation regardless of insertion order
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = val[key]
          return result
        }, {})
    }
    return val
  })
}

// ---------------------------------------------------------------------------
// Object Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `val` is a plain data object — i.e. created via `{}` or
 * `Object.create(null)` — as opposed to a class instance, array, or null.
 *
 * Used by hashQueryKey to decide whether to sort an object's keys.
 */
export function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null) return false
  const prototype = Object.getPrototypeOf(val) as unknown
  return (
    prototype === Object.prototype ||
    prototype === null ||
    Object.getPrototypeOf(prototype) === null
  )
}

/**
 * Shallow equality comparison for two objects of the same type.
 *
 * Returns true if both objects have the same keys and each key maps to the
 * same value (compared with ===). Does NOT recurse into nested objects.
 *
 * Used by QueryObserver to avoid triggering unnecessary re-renders when the
 * result object is structurally identical to the previous one.
 */
export function shallowEqualObjects<T extends Record<string, unknown>>(
  a: T,
  b: T,
): boolean {
  if (a === b) return true
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => a[key] === b[key])
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Returns how many milliseconds remain before data at `updatedAt` becomes
 * stale given a `staleTime` window.
 *
 * Returns 0 (not negative) if the data is already stale, which makes it safe
 * to use directly as a setTimeout duration.
 *
 * @param updatedAt - Unix timestamp (ms) when the data was last fetched
 * @param staleTime - How long (ms) data remains fresh
 */
export function timeUntilStale(updatedAt: number, staleTime: number): number {
  return Math.max(updatedAt + staleTime - Date.now(), 0)
}

// ---------------------------------------------------------------------------
// Query Key Matching
// ---------------------------------------------------------------------------

/**
 * Determines whether `queryKey` matches `target` according to TanStack Query's
 * key-matching rules.
 *
 * Exact mode:
 *   The hash of both keys must be identical.
 *
 * Partial mode (default):
 *   Each element in `target` must deeply equal the corresponding element in
 *   `queryKey` at the same index. `queryKey` may have extra trailing elements.
 *   This is element-level prefix matching (not string prefix matching).
 *
 * @example
 * // Partial match
 * matchesQueryKey(['users', 1], ['users'], false)  // true
 * matchesQueryKey(['todos', 1], ['users'], false)  // false
 * matchesQueryKey(['todo'],     ['to'],    false)  // false (element mismatch)
 *
 * // Exact match
 * matchesQueryKey(['users', 1], ['users'], true)   // false
 * matchesQueryKey(['users'],    ['users'], true)   // true
 */
export function matchesQueryKey(
  queryKey: QueryKey,
  target: QueryKey,
  exact: boolean,
): boolean {
  if (exact) {
    return hashQueryKey(queryKey) === hashQueryKey(target)
  }
  // Element-level prefix matching: every element in `target` must match
  // the corresponding element in `queryKey`. We compare via hashQueryKey
  // on single-element arrays for deep equality with sorted object keys.
  if (queryKey.length < target.length) return false
  return target.every(
    (element, index) =>
      hashQueryKey([element]) === hashQueryKey([queryKey[index]]),
  )
}

// ---------------------------------------------------------------------------
// Async Utilities
// ---------------------------------------------------------------------------

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Useful for implementing exponential back-off retry delays in tests and
 * retry schedulers.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Functional Utilities
// ---------------------------------------------------------------------------

/** A function that does nothing. Used as a safe default callback. */
export const noop = (): void => {}

/**
 * The identity function — returns its argument unchanged.
 * Used as a default `select` transform when none is provided.
 */
export function identity<T>(x: T): T {
  return x
}
