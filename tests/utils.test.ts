import { describe, it, expect, vi } from 'vitest'
import {
  hashQueryKey,
  matchesQueryKey,
  shallowEqualObjects,
  timeUntilStale,
  isServer,
  isValidTimeout,
  isPlainObject,
  noop,
  identity,
  sleep,
} from '../src/core/utils'

// ---------------------------------------------------------------------------
// hashQueryKey
// ---------------------------------------------------------------------------

describe('hashQueryKey', () => {
  it('produces a stable hash for a simple string key', () => {
    const hash = hashQueryKey(['users'])
    expect(hash).toBe('["users"]')
  })

  it('produces the same hash regardless of object key insertion order', () => {
    const hash1 = hashQueryKey(['users', { role: 'admin', page: 1 }])
    const hash2 = hashQueryKey(['users', { page: 1, role: 'admin' }])
    expect(hash1).toBe(hash2)
  })

  it('handles deeply nested objects with sorted keys', () => {
    const hash1 = hashQueryKey([{ b: { d: 1, c: 2 }, a: 3 }])
    const hash2 = hashQueryKey([{ a: 3, b: { c: 2, d: 1 } }])
    expect(hash1).toBe(hash2)
  })

  it('handles nested arrays (arrays are not key-sorted)', () => {
    const hash = hashQueryKey([['a', 'b'], [1, 2]])
    expect(hash).toBe('[["a","b"],[1,2]]')
  })

  it('handles empty array key', () => {
    const hash = hashQueryKey([])
    expect(hash).toBe('[]')
  })

  it('handles null and undefined values in the key', () => {
    const hash = hashQueryKey([null, undefined])
    expect(hash).toBe('[null,null]')
  })

  it('handles numbers and booleans', () => {
    const hash = hashQueryKey([1, true, false, 0])
    expect(hash).toBe('[1,true,false,0]')
  })

  it('handles class instances without sorting their keys', () => {
    class MyClass {
      b = 2
      a = 1
    }
    // Class instances are NOT plain objects, so their keys are NOT sorted
    const instance = new MyClass()
    const hash = hashQueryKey([instance])
    // JSON.stringify of non-plain objects respects insertion order
    expect(hash).toBe('[{"b":2,"a":1}]')
  })
})

// ---------------------------------------------------------------------------
// matchesQueryKey
// ---------------------------------------------------------------------------

describe('matchesQueryKey', () => {
  it('returns true for exact match of identical keys', () => {
    expect(matchesQueryKey(['users'], ['users'], true)).toBe(true)
  })

  it('returns false for exact match when keys differ', () => {
    expect(matchesQueryKey(['users', 1], ['users'], true)).toBe(false)
  })

  it('returns true for prefix match (partial)', () => {
    expect(matchesQueryKey(['users', 1], ['users'], false)).toBe(true)
  })

  it('returns false for prefix match when prefix does not match', () => {
    expect(matchesQueryKey(['todos', 1], ['users'], false)).toBe(false)
  })

  it('matches empty target array as prefix of any key', () => {
    // Empty array hash is '[]', stripped becomes '[', which is a prefix of any JSON array
    expect(matchesQueryKey(['anything'], [], false)).toBe(true)
  })

  it('exact match with object keys (sorted)', () => {
    expect(
      matchesQueryKey(
        ['users', { page: 1, role: 'admin' }],
        ['users', { role: 'admin', page: 1 }],
        true,
      ),
    ).toBe(true)
  })

  it('partial match with object keys', () => {
    expect(
      matchesQueryKey(
        ['users', { page: 1 }],
        ['users'],
        false,
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shallowEqualObjects
// ---------------------------------------------------------------------------

describe('shallowEqualObjects', () => {
  it('returns true for the same reference', () => {
    const obj = { a: 1, b: 2 }
    expect(shallowEqualObjects(obj, obj)).toBe(true)
  })

  it('returns true for structurally identical objects', () => {
    expect(shallowEqualObjects({ a: 1, b: 'hello' }, { a: 1, b: 'hello' })).toBe(true)
  })

  it('returns false when a value differs', () => {
    expect(shallowEqualObjects({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('returns false when keys are added', () => {
    expect(
      shallowEqualObjects({ a: 1 } as Record<string, unknown>, { a: 1, b: 2 }),
    ).toBe(false)
  })

  it('returns false when keys are removed', () => {
    expect(
      shallowEqualObjects({ a: 1, b: 2 }, { a: 1 } as Record<string, unknown>),
    ).toBe(false)
  })

  it('does not recurse into nested objects', () => {
    const nested1 = { x: 1 }
    const nested2 = { x: 1 }
    // Different references, so shallow equality fails for the nested key
    expect(shallowEqualObjects({ a: nested1 }, { a: nested2 })).toBe(false)
    // Same reference, passes
    expect(shallowEqualObjects({ a: nested1 }, { a: nested1 })).toBe(true)
  })

  it('returns true for two empty objects', () => {
    expect(shallowEqualObjects({}, {})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// timeUntilStale
// ---------------------------------------------------------------------------

describe('timeUntilStale', () => {
  it('returns 0 when data is already stale', () => {
    const updatedAt = Date.now() - 10000 // 10 seconds ago
    expect(timeUntilStale(updatedAt, 5000)).toBe(0)
  })

  it('returns remaining time when data is still fresh', () => {
    const now = Date.now()
    const updatedAt = now - 1000 // 1 second ago
    const staleTime = 5000 // 5 seconds
    const result = timeUntilStale(updatedAt, staleTime)
    // Should be approximately 4000ms
    expect(result).toBeGreaterThan(3900)
    expect(result).toBeLessThanOrEqual(4000)
  })

  it('returns the staleTime when data was just updated', () => {
    const now = Date.now()
    const result = timeUntilStale(now, 5000)
    // Should be approximately 5000ms
    expect(result).toBeGreaterThan(4900)
    expect(result).toBeLessThanOrEqual(5000)
  })

  it('never returns negative values', () => {
    const updatedAt = Date.now() - 100000
    expect(timeUntilStale(updatedAt, 1000)).toBe(0)
  })

  it('returns 0 when staleTime is 0', () => {
    expect(timeUntilStale(Date.now(), 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// isServer
// ---------------------------------------------------------------------------

describe('isServer', () => {
  it('should be false in jsdom environment', () => {
    expect(isServer).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isValidTimeout
// ---------------------------------------------------------------------------

describe('isValidTimeout', () => {
  it('returns true for 0', () => {
    expect(isValidTimeout(0)).toBe(true)
  })

  it('returns true for a positive number', () => {
    expect(isValidTimeout(5000)).toBe(true)
  })

  it('returns false for Infinity', () => {
    expect(isValidTimeout(Infinity)).toBe(false)
  })

  it('returns false for negative numbers', () => {
    expect(isValidTimeout(-1)).toBe(false)
  })

  it('returns false for non-numbers', () => {
    expect(isValidTimeout('hello')).toBe(false)
    expect(isValidTimeout(undefined)).toBe(false)
    expect(isValidTimeout(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isPlainObject
// ---------------------------------------------------------------------------

describe('isPlainObject', () => {
  it('returns true for object literals', () => {
    expect(isPlainObject({ a: 1 })).toBe(true)
  })

  it('returns true for Object.create(null)', () => {
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('returns false for arrays', () => {
    expect(isPlainObject([1, 2, 3])).toBe(false)
  })

  it('returns false for null', () => {
    expect(isPlainObject(null)).toBe(false)
  })

  it('returns false for class instances', () => {
    class Foo {}
    expect(isPlainObject(new Foo())).toBe(false)
  })

  it('returns false for primitives', () => {
    expect(isPlainObject(42)).toBe(false)
    expect(isPlainObject('string')).toBe(false)
    expect(isPlainObject(true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// noop
// ---------------------------------------------------------------------------

describe('noop', () => {
  it('is a function that returns undefined', () => {
    expect(typeof noop).toBe('function')
    expect(noop()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe('identity', () => {
  it('returns the same value passed in', () => {
    expect(identity(42)).toBe(42)
    expect(identity('hello')).toBe('hello')
    const obj = { a: 1 }
    expect(identity(obj)).toBe(obj)
  })

  it('returns undefined when passed undefined', () => {
    expect(identity(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('sleep', () => {
  it('returns a promise that resolves after the given time', async () => {
    vi.useFakeTimers()
    let resolved = false
    const p = sleep(100).then(() => { resolved = true })

    expect(resolved).toBe(false)
    vi.advanceTimersByTime(100)
    await p
    expect(resolved).toBe(true)
  })
})
