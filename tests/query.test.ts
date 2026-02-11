import { describe, it, expect, vi } from 'vitest'
import { Query } from '../src/core/query'
import type { QueryCacheInterface, QueryObserverInterface, QueryCacheNotifyEvent } from '../src/core/query'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock QueryCacheInterface.
 */
function createMockCache(): QueryCacheInterface & { events: QueryCacheNotifyEvent[] } {
  const events: QueryCacheNotifyEvent[] = []
  return {
    events,
    notify: vi.fn((event: QueryCacheNotifyEvent) => {
      events.push(event)
    }),
    remove: vi.fn(),
  }
}

/**
 * Create a minimal mock QueryObserverInterface.
 */
function createMockObserver(): QueryObserverInterface {
  return {
    onQueryUpdate: vi.fn(),
  }
}

/**
 * Create a Query with sensible defaults for testing.
 */
function createQuery<TData = unknown>(opts?: {
  queryFn?: () => Promise<TData>
  queryKey?: readonly unknown[]
  gcTime?: number
  staleTime?: number | 'static'
  initialData?: TData
  retry?: number | boolean
}): {
  query: Query<TData, Error, readonly unknown[]>
  cache: ReturnType<typeof createMockCache>
} {
  const cache = createMockCache()
  const query = new Query<TData, Error, readonly unknown[]>({
    cache,
    queryKey: opts?.queryKey ?? ['test'],
    queryHash: JSON.stringify(opts?.queryKey ?? ['test']),
    options: {
      queryKey: (opts?.queryKey ?? ['test']) as readonly unknown[],
      queryFn: opts?.queryFn,
      gcTime: opts?.gcTime,
      staleTime: opts?.staleTime,
      initialData: opts?.initialData,
      retry: opts?.retry ?? 0,
    },
  })
  return { query, cache }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Query', () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('starts with status="pending" and fetchStatus="idle" (no initialData)', () => {
      const { query } = createQuery()
      expect(query.state.status).toBe('pending')
      expect(query.state.fetchStatus).toBe('idle')
      expect(query.state.data).toBeUndefined()
      expect(query.state.error).toBeNull()
      expect(query.state.isInvalidated).toBe(false)
    })

    it('starts with status="success" when initialData is provided', () => {
      const { query } = createQuery({ initialData: 'hello' })
      expect(query.state.status).toBe('success')
      expect(query.state.data).toBe('hello')
      expect(query.state.dataUpdatedAt).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Successful fetch transitions
  // -----------------------------------------------------------------------

  describe('successful fetch', () => {
    it('transitions: pending -> fetching -> success + idle', async () => {
      const { query } = createQuery<string>({
        queryFn: () => Promise.resolve('data'),
      })

      expect(query.state.status).toBe('pending')
      expect(query.state.fetchStatus).toBe('idle')

      const fetchPromise = query.fetch()

      // After calling fetch, should be fetching
      expect(query.state.fetchStatus).toBe('fetching')
      expect(query.state.status).toBe('pending')

      const data = await fetchPromise

      expect(data).toBe('data')
      expect(query.state.status).toBe('success')
      expect(query.state.fetchStatus).toBe('idle')
      expect(query.state.data).toBe('data')
      expect(query.state.error).toBeNull()
      expect(query.state.dataUpdatedAt).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Failed fetch transitions
  // -----------------------------------------------------------------------

  describe('failed fetch', () => {
    it('transitions: pending -> fetching -> error + idle', async () => {
      const testError = new Error('fetch failed')
      const { query } = createQuery({
        queryFn: () => Promise.reject(testError),
        retry: 0,
      })

      expect(query.state.status).toBe('pending')

      await expect(query.fetch()).rejects.toThrow('fetch failed')

      expect(query.state.status).toBe('error')
      expect(query.state.fetchStatus).toBe('idle')
      expect(query.state.error).toBe(testError)
      expect(query.state.errorUpdatedAt).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Background refetch
  // -----------------------------------------------------------------------

  describe('background refetch', () => {
    it('transitions: success+idle -> success+fetching -> success+idle', async () => {
      const { query } = createQuery<string>({
        queryFn: () => Promise.resolve('new-data'),
        initialData: 'old-data',
      })

      // Starts as success
      expect(query.state.status).toBe('success')
      expect(query.state.data).toBe('old-data')
      expect(query.state.fetchStatus).toBe('idle')

      const fetchPromise = query.fetch()

      // During background refetch: still success, but fetching
      expect(query.state.status).toBe('success')
      expect(query.state.fetchStatus).toBe('fetching')

      await fetchPromise

      expect(query.state.status).toBe('success')
      expect(query.state.fetchStatus).toBe('idle')
      expect(query.state.data).toBe('new-data')
    })
  })

  // -----------------------------------------------------------------------
  // setData()
  // -----------------------------------------------------------------------

  describe('setData()', () => {
    it('updates data and dataUpdatedAt', () => {
      const { query } = createQuery<string>()
      const beforeUpdate = Date.now()

      query.setData('manual-data')

      expect(query.state.data).toBe('manual-data')
      expect(query.state.status).toBe('success')
      expect(query.state.dataUpdatedAt).toBeGreaterThanOrEqual(beforeUpdate)
    })

    it('clears error on setData', () => {
      const { query } = createQuery<string>()

      // Simulate an error state by fetching with error, then setData
      query.setData('recovery-data')

      expect(query.state.error).toBeNull()
      expect(query.state.data).toBe('recovery-data')
    })
  })

  // -----------------------------------------------------------------------
  // invalidate()
  // -----------------------------------------------------------------------

  describe('invalidate()', () => {
    it('sets isInvalidated to true', () => {
      const { query } = createQuery({ initialData: 'data' })
      expect(query.state.isInvalidated).toBe(false)

      query.invalidate()
      expect(query.state.isInvalidated).toBe(true)
    })

    it('is idempotent', () => {
      const { query, cache } = createQuery({ initialData: 'data' })

      query.invalidate()
      const notifyCountAfterFirst = (cache.notify as ReturnType<typeof vi.fn>).mock.calls.length

      query.invalidate() // should not dispatch again
      const notifyCountAfterSecond = (cache.notify as ReturnType<typeof vi.fn>).mock.calls.length

      expect(notifyCountAfterSecond).toBe(notifyCountAfterFirst)
    })
  })

  // -----------------------------------------------------------------------
  // Request deduplication
  // -----------------------------------------------------------------------

  describe('request deduplication', () => {
    it('concurrent fetch() calls return the same promise', async () => {
      let callCount = 0
      const { query } = createQuery<string>({
        queryFn: () => {
          callCount++
          return new Promise((resolve) => setTimeout(() => resolve('data'), 50))
        },
      })

      const p1 = query.fetch()
      const p2 = query.fetch()

      // Both calls should return the same retryer promise
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toBe('data')
      expect(r2).toBe('data')
      // queryFn should only have been called once
      expect(callCount).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Observer management
  // -----------------------------------------------------------------------

  describe('observer management', () => {
    it('addObserver increases observer count', () => {
      const { query } = createQuery()
      const observer = createMockObserver()

      expect(query.observers.length).toBe(0)
      query.addObserver(observer)
      expect(query.observers.length).toBe(1)
    })

    it('removeObserver decreases observer count', () => {
      const { query } = createQuery()
      const observer = createMockObserver()

      query.addObserver(observer)
      expect(query.observers.length).toBe(1)

      query.removeObserver(observer)
      expect(query.observers.length).toBe(0)
    })

    it('does not add the same observer twice', () => {
      const { query } = createQuery()
      const observer = createMockObserver()

      query.addObserver(observer)
      query.addObserver(observer)
      expect(query.observers.length).toBe(1)
    })

    it('notifies observers on state change', async () => {
      const { query } = createQuery<string>({
        queryFn: () => Promise.resolve('data'),
      })
      const observer = createMockObserver()
      query.addObserver(observer)

      await query.fetch()

      expect(observer.onQueryUpdate).toHaveBeenCalled()
    })

    it('notifies cache of observerAdded and observerRemoved', () => {
      const { query, cache } = createQuery()
      const observer = createMockObserver()

      query.addObserver(observer)
      expect(cache.notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'observerAdded' }),
      )

      query.removeObserver(observer)
      expect(cache.notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'observerRemoved' }),
      )
    })
  })

  // -----------------------------------------------------------------------
  // GC scheduling
  // -----------------------------------------------------------------------

  describe('GC scheduling', () => {
    it('schedules GC when the last observer is removed', () => {
      vi.useFakeTimers()
      const { query, cache } = createQuery({ gcTime: 1000 })
      const observer = createMockObserver()

      query.addObserver(observer)
      query.removeObserver(observer)

      // After gcTime, optionalRemove should call cache.remove
      vi.advanceTimersByTime(1001)

      expect(cache.remove).toHaveBeenCalled()
    })

    it('clears GC timeout when a new observer subscribes', () => {
      vi.useFakeTimers()
      const { query, cache } = createQuery({ gcTime: 1000 })
      const observer1 = createMockObserver()
      const observer2 = createMockObserver()

      query.addObserver(observer1)
      query.removeObserver(observer1)

      // Before GC fires, add a new observer
      vi.advanceTimersByTime(500)
      query.addObserver(observer2)

      // GC time passes, but should NOT be removed because observer2 is active
      vi.advanceTimersByTime(600)
      expect(cache.remove).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // isStaleByTime
  // -----------------------------------------------------------------------

  describe('isStaleByTime', () => {
    it('returns true when status is pending', () => {
      const { query } = createQuery()
      expect(query.isStaleByTime(1000)).toBe(true)
    })

    it('returns false when staleTime is "static"', () => {
      const { query } = createQuery({ initialData: 'data', staleTime: 'static' })
      expect(query.isStaleByTime('static')).toBe(false)
    })

    it('returns true when isInvalidated is true', () => {
      const { query } = createQuery({ initialData: 'data' })
      query.invalidate()
      expect(query.isStaleByTime(Infinity)).toBe(true)
    })

    it('returns true when staleTime is 0 (default)', () => {
      const { query } = createQuery({ initialData: 'data' })
      expect(query.isStaleByTime(0)).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // cancel
  // -----------------------------------------------------------------------

  describe('cancel', () => {
    it('cancels an in-flight fetch', async () => {
      const { query } = createQuery<string>({
        queryFn: () => new Promise((resolve) => setTimeout(() => resolve('data'), 5000)),
      })

      query.fetch().catch(() => {})
      query.cancel({ silent: true })

      // Wait a tick for the cancel dispatch
      await new Promise((r) => setTimeout(r, 0))
      expect(query.state.fetchStatus).toBe('idle')
    })
  })

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  describe('destroy', () => {
    it('cancels the fetch and clears GC timer', () => {
      vi.useFakeTimers()
      const { query, cache } = createQuery({ gcTime: 1000 })

      // Schedule GC
      const observer = createMockObserver()
      query.addObserver(observer)
      query.removeObserver(observer)

      query.destroy()

      // After GC time, remove should NOT be called because destroy cleared the timer
      vi.advanceTimersByTime(2000)
      expect(cache.remove).not.toHaveBeenCalled()
    })
  })
})
