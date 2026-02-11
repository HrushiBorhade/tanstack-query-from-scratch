import { describe, it, expect, vi } from 'vitest'
import { QueryCache } from '../src/core/queryCache'
import type { QueryClientInterface } from '../src/core/queryCache'
import { Query } from '../src/core/query'
import type { QueryCacheNotifyEvent } from '../src/core/query'
import { hashQueryKey } from '../src/core/utils'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mock of QueryClientInterface that just passes options through.
 */
function createMockClient(): QueryClientInterface {
  return {
    defaultQueryOptions: (options) => options,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryCache', () => {
  // -----------------------------------------------------------------------
  // build()
  // -----------------------------------------------------------------------

  describe('build()', () => {
    it('creates a new Query for a new key', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const query = cache.build(client, {
        queryKey: ['users'],
        queryFn: () => Promise.resolve([]),
      })

      expect(query).toBeDefined()
      expect(query.queryKey).toEqual(['users'])
      expect(query.queryHash).toBe(hashQueryKey(['users']))
    })

    it('returns existing Query for the same key (dedup)', () => {
      const cache = new QueryCache()
      const client = createMockClient()

      const query1 = cache.build(client, {
        queryKey: ['users'],
        queryFn: () => Promise.resolve([]),
      })
      const query2 = cache.build(client, {
        queryKey: ['users'],
        queryFn: () => Promise.resolve([]),
      })

      expect(query1).toBe(query2)
    })

    it('creates different queries for different keys', () => {
      const cache = new QueryCache()
      const client = createMockClient()

      const q1 = cache.build(client, { queryKey: ['users'] })
      const q2 = cache.build(client, { queryKey: ['todos'] })

      expect(q1).not.toBe(q2)
      expect(q1.queryKey).toEqual(['users'])
      expect(q2.queryKey).toEqual(['todos'])
    })
  })

  // -----------------------------------------------------------------------
  // find()
  // -----------------------------------------------------------------------

  describe('find()', () => {
    it('finds a query with exact match', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      cache.build(client, { queryKey: ['users', 1] })

      const found = cache.find({ queryKey: ['users', 1], exact: true })
      expect(found).toBeDefined()
      expect(found!.queryKey).toEqual(['users', 1])
    })

    it('returns undefined when no exact match exists', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      cache.build(client, { queryKey: ['users', 1] })

      const found = cache.find({ queryKey: ['users'], exact: true })
      expect(found).toBeUndefined()
    })

    it('finds a query with partial match', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      cache.build(client, { queryKey: ['users', 1] })

      const found = cache.find({ queryKey: ['users'] })
      expect(found).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // findAll()
  // -----------------------------------------------------------------------

  describe('findAll()', () => {
    it('returns all queries when no filters provided', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      cache.build(client, { queryKey: ['users'] })
      cache.build(client, { queryKey: ['todos'] })

      expect(cache.findAll()).toHaveLength(2)
    })

    it('filters by type: active (has observers)', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const q1 = cache.build(client, { queryKey: ['users'] })
      cache.build(client, { queryKey: ['todos'] })

      // Add a mock observer to q1 to make it "active"
      q1.addObserver({ onQueryUpdate: vi.fn() })

      const active = cache.findAll({ type: 'active' })
      expect(active).toHaveLength(1)
      expect(active[0].queryKey).toEqual(['users'])
    })

    it('filters by type: inactive (no observers)', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const q1 = cache.build(client, { queryKey: ['users'] })
      cache.build(client, { queryKey: ['todos'] })

      q1.addObserver({ onQueryUpdate: vi.fn() })

      const inactive = cache.findAll({ type: 'inactive' })
      expect(inactive).toHaveLength(1)
      expect(inactive[0].queryKey).toEqual(['todos'])
    })

    it('filters by queryKey prefix', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      cache.build(client, { queryKey: ['users', 1] })
      cache.build(client, { queryKey: ['users', 2] })
      cache.build(client, { queryKey: ['todos'] })

      const found = cache.findAll({ queryKey: ['users'] })
      expect(found).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // remove()
  // -----------------------------------------------------------------------

  describe('remove()', () => {
    it('deletes a query from cache', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const query = cache.build(client, { queryKey: ['users'] })

      expect(cache.getAll()).toHaveLength(1)
      cache.remove(query as unknown as Query)
      expect(cache.getAll()).toHaveLength(0)
    })

    it('is idempotent (removing same query twice is a no-op)', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const query = cache.build(client, { queryKey: ['users'] })

      cache.remove(query as unknown as Query)
      cache.remove(query as unknown as Query) // should not throw
      expect(cache.getAll()).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('empties the cache', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      cache.build(client, { queryKey: ['users'] })
      cache.build(client, { queryKey: ['todos'] })

      expect(cache.getAll()).toHaveLength(2)
      cache.clear()
      expect(cache.getAll()).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // getAll()
  // -----------------------------------------------------------------------

  describe('getAll()', () => {
    it('returns all queries', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      cache.build(client, { queryKey: ['users'] })
      cache.build(client, { queryKey: ['todos'] })
      cache.build(client, { queryKey: ['posts'] })

      expect(cache.getAll()).toHaveLength(3)
    })

    it('returns an empty array for an empty cache', () => {
      const cache = new QueryCache()
      expect(cache.getAll()).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe('get()', () => {
    it('returns query by hash', () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const query = cache.build(client, { queryKey: ['users'] })

      const found = cache.get(hashQueryKey(['users']))
      expect(found).toBe(query)
    })

    it('returns undefined for unknown hash', () => {
      const cache = new QueryCache()
      expect(cache.get('unknown-hash')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Cache listener / notify
  // -----------------------------------------------------------------------

  describe('notify / subscribe', () => {
    it('cache listener receives "added" event when a query is built', async () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const events: QueryCacheNotifyEvent[] = []

      cache.subscribe((event) => events.push(event))

      cache.build(client, { queryKey: ['users'] })

      // notifyManager uses setTimeout(0), so we need to wait
      await vi.waitFor(() => {
        expect(events.length).toBeGreaterThanOrEqual(1)
      })

      expect(events.some((e) => e.type === 'added')).toBe(true)
    })

    it('cache listener receives "removed" event when a query is removed', async () => {
      const cache = new QueryCache()
      const client = createMockClient()
      const events: QueryCacheNotifyEvent[] = []

      const query = cache.build(client, { queryKey: ['users'] })
      cache.subscribe((event) => events.push(event))

      cache.remove(query as unknown as Query)

      await vi.waitFor(() => {
        expect(events.some((e) => e.type === 'removed')).toBe(true)
      })
    })
  })
})
